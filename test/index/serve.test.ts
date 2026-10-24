import { chmodSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../src/index/serve.js";

let close: () => Promise<void>;
let base: string;
let port: number;
let dir: string;
let httpServer: Server;

/** Sends the path byte for byte, which fetch would normalise or reject. */
function raw(path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "srv-"));
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  writeFileSync(join(dir, "latest.json"), "{}");
  // history.json is deliberately not written: it is on the allow-list but missing on disk.
  const s = await startServer(dir, 0);
  close = s.close;
  port = s.port;
  httpServer = s.server;
  base = `http://127.0.0.1:${s.port}`;
});
afterAll(async () => { await close(); });

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe("serve", () => {
  it("serves the page at / and the files by name with no caching surprises", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const j = await fetch(`${base}/latest.json`);
    expect(j.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(j.headers.get("cache-control")).toBe("public, max-age=60");
  });
  it("answers 404 for anything else and 405 for writes, never reading outside the directory", async () => {
    expect((await fetch(`${base}/other.txt`)).status).toBe(404);
    expect((await fetch(`${base}/latest.json`, { method: "POST" })).status).toBe(405);
  });
  it("sets the security headers on every response, including 404 and 405", async () => {
    const responses = [
      await fetch(`${base}/`),
      await fetch(`${base}/latest.json`),
      await fetch(`${base}/healthz`),
      await fetch(`${base}/other.txt`),
      await fetch(`${base}/history.json`),
      await fetch(`${base}/latest.json`, { method: "POST" }),
    ];
    for (const r of responses) {
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("content-security-policy")).toBe(CSP);
    }
  });
  it("allows cross-origin reads on the two JSON files only", async () => {
    expect((await fetch(`${base}/latest.json`)).headers.get("access-control-allow-origin")).toBe("*");
    const h = await fetch(`${base}/history.json`);
    expect(h.status).toBe(404); // missing on disk, see beforeAll
    expect(h.headers.get("access-control-allow-origin")).toBe("*");
    expect((await fetch(`${base}/`)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/index.html`)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/healthz`)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${base}/other.txt`)).headers.get("access-control-allow-origin")).toBeNull();
  });
  it("answers /healthz with 200 ok without touching the disk", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("answers /healthz even when the served directory does not exist", async () => {
    const s = await startServer(join(tmpdir(), "srv-does-not-exist-xyz"), 0);
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/healthz`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("ok");
    } finally {
      await s.close();
    }
  });
  it("answers 404, not a crash, for malformed URLs", async () => {
    for (const path of ["/../package.json", "/./latest.json", "/latest.json/", "/INDEX.HTML", "/__proto__", "/constructor", "/%E0%A4%A", "/%", "/%zz", "//", "/\\", "http://evil.example/latest.json%00", "/latest.json%2e%2e"]) {
      const r = await raw(path);
      expect(r.status, path).toBe(404);
    }
    // the server is still up afterwards
    expect((await fetch(`${base}/latest.json`)).status).toBe(200);
  });
  it("ignores the query string and nothing else about the path", async () => {
    expect((await fetch(`${base}/latest.json?x=1`)).status).toBe(200);
    expect((await fetch(`${base}/%6Catest.json`)).status).toBe(404);
  });
  it("answers HEAD with the same headers as GET and no body", async () => {
    const g = await fetch(`${base}/latest.json`);
    const h = await raw("/latest.json", "HEAD");
    expect(h.status).toBe(200);
    expect(h.body).toBe("");
    expect(h.headers["content-length"]).toBe(String((await g.text()).length));
    expect(h.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(h.headers["x-content-type-options"]).toBe("nosniff");
    const hz = await raw("/healthz", "HEAD");
    expect(hz.status).toBe(200);
    expect(hz.body).toBe("");
  });
  it("answers 404 for an allow-listed file that is missing on disk", async () => {
    const r = await fetch(`${base}/history.json`);
    expect(r.status).toBe(404);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("sets no-store on 404 and 405 and the Allow header on 405", async () => {
    const nf = await fetch(`${base}/other.txt`);
    expect(nf.headers.get("cache-control")).toBe("no-store");
    const na = await fetch(`${base}/latest.json`, { method: "POST" });
    expect(na.status).toBe(405);
    expect(na.headers.get("allow")).toBe("GET, HEAD");
    expect(na.headers.get("cache-control")).toBe("no-store");
  });
  it("answers 500 with no-store and one stderr line (code and file name, not the path) for a non-ENOENT error", async () => {
    const d = mkdtempSync(join(tmpdir(), "srv-"));
    mkdirSync(join(d, "latest.json")); // a directory where the file should be
    const s = await startServer(d, 0);
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/latest.json?secret=1`);
      expect(r.status).toBe(500);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      console.error = orig;
      await s.close();
    }
    expect(logged).toEqual(["serve: EISDIR latest.json"]);
  });
  it("answers 304 with the same security headers when If-None-Match matches, and 200 when it does not", async () => {
    const r = await fetch(`${base}/latest.json`);
    const etag = r.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/"[\d.]+-2"$/);
    expect(r.headers.get("last-modified")).toMatch(/GMT$/);
    const hit = await fetch(`${base}/latest.json`, { headers: { "if-none-match": etag } });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe("");
    expect(hit.headers.get("content-security-policy")).toBe(CSP);
    expect(hit.headers.get("etag")).toBe(etag);
    const miss = await fetch(`${base}/latest.json`, { headers: { "if-none-match": 'W/"0-0"' } });
    expect(miss.status).toBe(200);
  });
  it("serves new content after the file is rewritten with a new mtime", async () => {
    const d = mkdtempSync(join(tmpdir(), "srv-"));
    const f = join(d, "latest.json");
    writeFileSync(f, '{"a":1}');
    utimesSync(f, 1_000, 1_000);
    const s = await startServer(d, 0);
    try {
      const u = `http://127.0.0.1:${s.port}/latest.json`;
      const first = await fetch(u);
      expect(await first.text()).toBe('{"a":1}');
      writeFileSync(f, '{"a":2}'); // same size, so only the mtime tells them apart
      utimesSync(f, 2_000, 2_000);
      const second = await fetch(u);
      expect(await second.text()).toBe('{"a":2}');
      expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
    } finally {
      await s.close();
    }
  });
  it("answers HEAD from the stat alone: correct content-length even when the file cannot be opened", async () => {
    const d = mkdtempSync(join(tmpdir(), "srv-"));
    const f = join(d, "latest.json");
    writeFileSync(f, '{"a":123}');
    chmodSync(f, 0o000);
    const s = await startServer(d, 0);
    try {
      const h = await fetch(`http://127.0.0.1:${s.port}/latest.json`, { method: "HEAD" });
      expect(h.status).toBe(200);
      expect(h.headers.get("content-length")).toBe(String(statSync(f).size));
      expect(await h.text()).toBe("");
      // the same file is unreadable, so a GET proves the HEAD above never opened it (skipped when running as root)
      if (process.getuid?.() !== 0) expect((await fetch(`http://127.0.0.1:${s.port}/latest.json`)).status).toBe(500);
    } finally {
      chmodSync(f, 0o600);
      await s.close();
    }
  });
  it("rejects the startServer promise when the port is taken", async () => {
    await expect(startServer(dir, port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
  it("sets the timeouts for running behind Railway's proxy", () => {
    expect(httpServer.keepAliveTimeout).toBe(65_000);
    expect(httpServer.headersTimeout).toBe(30_000);
    expect(httpServer.requestTimeout).toBe(30_000);
    expect(httpServer.timeout).toBe(30_000);
  });
});
