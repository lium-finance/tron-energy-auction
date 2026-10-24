import { open, stat as statFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

/** close() waits this long for open connections, then closes them; shutdown's time bound counts on it. */
export const SERVER_CLOSE_FORCE_MS = 5_000;
/** Longer than the keep-alive of the proxy in front (Railway's is 60 s), so the server never closes a connection the proxy is about to reuse. */
const KEEP_ALIVE_MS = 65_000;
/** A client that has not sent its headers or finished its request by then is cut off. */
const SLOW_CLIENT_MS = 30_000;

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

/** Exact allow-list: request path to file. The request path is never joined onto `dir`; only `name` is. */
const FILES = new Map<string, { name: string; type: string; cors: boolean }>([
  ["/", { name: "index.html", type: HTML, cors: false }],
  ["/index.html", { name: "index.html", type: HTML, cors: false }],
  ["/latest.json", { name: "latest.json", type: JSON_TYPE, cors: true }],
  ["/history.json", { name: "history.json", type: JSON_TYPE, cors: true }],
]);

/** The page has one inline <style> and no scripts, so everything else is off. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, headers: Record<string, string | number>, body?: Buffer | string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const errCode = (e: unknown): string => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "UNKNOWN");

/** True when the If-None-Match header lists `etag` (or `*`). Weak comparison, as RFC 9110 requires for this header. */
function matches(req: IncomingMessage, etag: string): boolean {
  const header = req.headers["if-none-match"];
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => strip(t) === strip(etag));
}

interface Cached { mtimeMs: number; size: number; body: Buffer }

/**
 * Serves exactly three files from `dir`. GET and HEAD only; `GET /healthz` answers `ok` without touching the disk.
 * Each file is stat-ed per request and its bytes are cached by (mtimeMs, size), so a republish is visible at once and
 * slow readers share one Buffer. HEAD and 304 use the stat only.
 */
export async function startServer(dir: string, port: number): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const cache = new Map<string, Cached>();

  /** Opens once so the stat and the bytes describe the same file even if a publish renames over it mid-request. */
  async function load(name: string): Promise<Cached> {
    const fh = await open(join(dir, name), "r");
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
      const hit = cache.get(name);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
      const body = await fh.readFile();
      const entry = { mtimeMs: st.mtimeMs, size: st.size, body };
      cache.set(name, entry);
      return entry;
    } finally {
      await fh.close();
    }
  }

  /** HEAD: the stat alone, no open and no read. */
  async function stat(name: string): Promise<{ mtimeMs: number; size: number }> {
    const st = await statFile(join(dir, name));
    if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
    return { mtimeMs: st.mtimeMs, size: st.size };
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, { allow: "GET, HEAD", "cache-control": "no-store" });
        return;
      }
      // No URL parsing and no percent-decoding: the path is looked up as sent, so malformed input is simply not on the list.
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const head = req.method === "HEAD";
      if (path === "/healthz") {
        send(res, 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": 2 }, head ? undefined : "ok");
        return;
      }
      const file = FILES.get(path);
      if (!file) {
        send(res, 404, { "cache-control": "no-store" });
        return;
      }
      const cors: Record<string, string> = file.cors ? { "access-control-allow-origin": "*" } : {};
      try {
        // The stat alone answers HEAD and a matching If-None-Match; only a GET that needs the bytes reads (or reuses) them.
        let meta: { mtimeMs: number; size: number } = await stat(file.name);
        let loaded: Cached | undefined;
        if (!head && !matches(req, `W/"${meta.mtimeMs}-${meta.size}"`)) {
          loaded = await load(file.name);
          meta = loaded;
        }
        const etag = `W/"${meta.mtimeMs}-${meta.size}"`;
        const validators = { etag, "last-modified": new Date(meta.mtimeMs).toUTCString(), "cache-control": "public, max-age=60", ...cors };
        if (matches(req, etag)) {
          send(res, 304, validators);
          return;
        }
        send(res, 200, { ...validators, "content-type": file.type, "content-length": loaded ? loaded.body.length : meta.size }, loaded?.body);
      } catch (e) {
        if (errCode(e) === "ENOENT") {
          send(res, 404, { ...cors, "cache-control": "no-store" });
          return;
        }
        console.error(`serve: ${errCode(e)} ${file.name}`);
        send(res, 500, { ...cors, "cache-control": "no-store" });
      }
    } catch (e) {
      console.error(`serve: ${errCode(e)} (handler)`);
      if (!res.headersSent) send(res, 500, { "cache-control": "no-store" });
      else res.destroy();
    }
  });

  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = SLOW_CLIENT_MS;
  server.requestTimeout = SLOW_CLIENT_MS;
  server.setTimeout(SLOW_CLIENT_MS);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: bound,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), SERVER_CLOSE_FORCE_MS);
        server.close((e) => {
          clearTimeout(force);
          if (e) reject(e);
          else resolve();
        });
      }),
  };
}
