import { createHash } from "node:crypto";
import { errorMessage } from "../core/errors.js";

export interface FetchOptions {
  /** Total time allowed for all attempts. */
  budgetMs: number;
  /** When the first attempt has not answered by this time, a second one starts; the first is abandoned. */
  retryAtMs: number;
  fetchImpl?: typeof fetch;
  /** Wait after a 429 before the one retry it gets; when less budget than this is left, a 429 fails at once. */
  backoffMs?: number;
  /** Largest successful response body accepted, in bytes. Default 2 MiB. */
  maxBytes?: number;
  /** What a successful body must be. "json" (the default) fails a body that does not start like JSON as `not-json`; "html" accepts any text, for venues whose only public price is a web page. */
  expect?: "json" | "html";
}

export type FetchResult =
  | { ok: true; status: number; body: string; payloadHash: string; ms: number }
  | {
      ok: false;
      kind: "timeout" | "upstream" | "rate-limited" | "not-json" | "network" | "too-large";
      status: number | null;
      reason: string;
      ms: number;
    };

/** The default cap on a successful response body, in bytes; also the cap on a stored raw payload (adapter.ts). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Wait after a 429 before its one retry, when the caller does not say. */
const DEFAULT_BACKOFF_MS = 2_000;
/** A failure response is read only as far as the reason column needs. */
const ERROR_BODY_BYTES = 1024;

const excerpt = (s: string): string => s.slice(0, 400).replace(/\s+/g, " ").slice(0, 200);
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const isAbort = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
const message = (e: unknown): string => excerpt(errorMessage(e));
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

interface Attempt {
  promise: Promise<Response>;
  /** Fires when the attempt is aborted or its budget timer runs out. */
  signal: AbortSignal;
  /** Cancel the request and its budget timer. */
  abort: () => void;
  /** Clear the budget timer only; the response body may still be read until the budget runs out. */
  clearTimer: () => void;
}

/**
 * Starts one request that aborts itself after timeoutMs. The timer stays armed after the headers arrive, so the
 * budget also bounds reading the body; the caller clears it with clearTimer() once it is done with the response.
 */
function startAttempt(url: string, init: RequestInit, timeoutMs: number, f: typeof fetch): Attempt {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const promise = (async () => f(url, { ...init, signal: controller.signal }))();
  return {
    promise,
    signal: controller.signal,
    abort: () => {
      clearTimeout(timer);
      controller.abort();
    },
    clearTimer: () => clearTimeout(timer),
  };
}

type BodyRead = { tooLarge: false; text: string } | { tooLarge: true };

/**
 * Reads a response body as a stream. With `truncateAt` it stops after that many bytes and returns what it has;
 * otherwise a body longer than `maxBytes` is cancelled and reported as too large. Rejects with an AbortError
 * when the attempt's signal fires, whether or not the fetch implementation propagates the abort to the stream.
 */
async function readBody(res: Response, signal: AbortSignal, maxBytes: number, truncateAt?: number): Promise<BodyRead> {
  const reader = res.body?.getReader();
  if (!reader) return { tooLarge: false, text: "" };
  const decoder = new TextDecoder();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (truncateAt !== undefined) {
        const room = truncateAt - total;
        total += value.byteLength;
        text += decoder.decode(value.subarray(0, Math.max(0, room)), { stream: true });
        if (total >= truncateAt) {
          void reader.cancel().catch(() => {});
          break;
        }
      } else {
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          return { tooLarge: true };
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    return { tooLarge: false, text };
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * One network call for every collector: a budget, one retry on a hung request, one backoff on 429, a size cap,
 * and a body excerpt for the reason column. Never throws; the caller gets a typed result either way. When it
 * returns, every timer it created is cleared and every attempt except the one whose response it returns is aborted.
 *
 * The hedge is only safe for idempotent GET or string-body POST requests (a stream body cannot be sent twice).
 * A caller's init.signal is ignored. The first answer wins, including a failure.
 */
export async function fetchQuote(url: string, init: RequestInit, o: FetchOptions): Promise<FetchResult> {
  const maxBytes = o.maxBytes ?? MAX_BODY_BYTES;
  const backoffMs = o.backoffMs ?? DEFAULT_BACKOFF_MS;
  if (
    !positive(o.budgetMs) ||
    !positive(o.retryAtMs) ||
    o.retryAtMs >= o.budgetMs ||
    !positive(maxBytes) ||
    !(typeof backoffMs === "number" && Number.isFinite(backoffMs) && backoffMs >= 0) ||
    !(o.expect === undefined || o.expect === "json" || o.expect === "html")
  ) {
    return { ok: false, kind: "network", status: null, reason: "invalid fetch options", ms: 0 };
  }
  const f = o.fetchImpl ?? fetch;
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const live: Attempt[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  /** The attempt whose response is being returned as a success; every other attempt is aborted on the way out. */
  let kept: Attempt | undefined;
  const timedOut = (): FetchResult => ({
    ok: false,
    kind: "timeout",
    status: null,
    reason: `timed out after ${o.budgetMs} ms (${attempts} attempts)`,
    ms: elapsed(),
  });
  try {
    let winner: Attempt;
    let res: Response;
    try {
      const raced = new Promise<{ res: Response; winner: Attempt }>((resolve, reject) => {
        const launch = (timeoutMs: number): void => {
          attempts += 1;
          const a = startAttempt(url, init, timeoutMs, f);
          live.push(a);
          a.promise.then((r) => resolve({ res: r, winner: a }), reject);
        };
        launch(o.budgetMs);
        retryTimer = setTimeout(() => launch(Math.max(1, o.budgetMs - o.retryAtMs)), o.retryAtMs);
      });
      ({ res, winner } = await raced);
    } catch (e) {
      return isAbort(e) ? timedOut() : { ok: false, kind: "network", status: null, reason: message(e), ms: elapsed() };
    }
    // Someone answered: no second request may start, and the one that lost is cancelled.
    clearTimeout(retryTimer);
    for (const a of live) if (a !== winner) a.abort();

    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      winner.abort();
      const remaining = o.budgetMs - elapsed();
      if (remaining < backoffMs) {
        return { ok: false, kind: "rate-limited", status: 429, reason: "429, too little budget left to back off and retry", ms: elapsed() };
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      attempts += 1;
      const retry = startAttempt(url, init, Math.max(1, o.budgetMs - elapsed()), f);
      live.push(retry);
      try {
        res = await retry.promise;
        winner = retry;
      } catch (e) {
        return isAbort(e)
          ? timedOut()
          : { ok: false, kind: "rate-limited", status: 429, reason: `429 then ${message(e)}`, ms: elapsed() };
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, kind: "rate-limited", status: 429, reason: "429 twice", ms: elapsed() };
      }
    }

    let text: string;
    try {
      if (res.ok) {
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          void res.body?.cancel().catch(() => {});
          return { ok: false, kind: "too-large", status: res.status, reason: `body larger than ${maxBytes} bytes`, ms: elapsed() };
        }
      }
      const read = await readBody(res, winner.signal, maxBytes, res.ok ? undefined : ERROR_BODY_BYTES);
      if (read.tooLarge) {
        return { ok: false, kind: "too-large", status: res.status, reason: `body larger than ${maxBytes} bytes`, ms: elapsed() };
      }
      text = read.text;
    } catch (e) {
      return isAbort(e) ? timedOut() : { ok: false, kind: "network", status: res.status, reason: message(e), ms: elapsed() };
    }
    if (!res.ok) return { ok: false, kind: "upstream", status: res.status, reason: `${res.status}: ${excerpt(text)}`, ms: elapsed() };
    const trimmed = text.trimStart();
    if ((o.expect ?? "json") === "json" && !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return { ok: false, kind: "not-json", status: res.status, reason: `not JSON: ${excerpt(text)}`, ms: elapsed() };
    }
    kept = winner;
    return { ok: true, status: res.status, body: text, payloadHash: sha256(text), ms: elapsed() };
  } finally {
    clearTimeout(retryTimer);
    for (const a of live) {
      if (a === kept) a.clearTimer();
      else a.abort();
    }
  }
}
