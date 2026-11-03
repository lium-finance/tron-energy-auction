import { normalise, type RawPrice } from "../core/normalise.js";
import type { Quote, Term } from "../core/types.js";
import { fetchQuote, MAX_BODY_BYTES, type FetchOptions } from "./http.js";
import { errorMessage } from "../core/errors.js";

export interface CollectContext {
  hour: number;
  now: Date;
  /** The hour's energy fee in sun, the normalisation ceiling. */
  energyFeeSun: number;
  /** TRX price in USD read this hour; null when CoinGecko failed. */
  trxUsd: number | null;
  fetchOptions: FetchOptions;
  /** Clock read after each fetch for `readAt`; defaults to `() => new Date()`. Callers must run print() with a `now` at or after the last readAt. */
  clock?: () => Date;
  /** Redacts secrets from any text that goes into `reason`. */
  redact: (s: string) => string;
  /**
   * Removes every configured secret value, literally, and leaves URLs as they are (redactConfiguredSecrets); applied to
   * `source`, which then keeps the endpoint's path. Absent: `source` goes through `redact` and keeps only the host.
   */
  redactValues?: (s: string) => string;
  env: NodeJS.ProcessEnv;
}

/** What a venue adapter returns from a parsed body: a raw price and how much the venue can fill. */
export interface Parsed {
  /** The price; null when the venue answered with nothing to price (an empty order book). Then `depth` is what it can fill (0) and the row is `no-depth` with `note` as its reason. */
  raw: RawPrice | null;
  /** Units the venue can fill at that price; null when the API does not say. */
  depth: number | null;
  /** What was priced, when it is not the size asked for; the reason on a `depth-unknown` row (redacted and capped like any reason). */
  note?: string;
}

export interface VenueAdapter {
  venue: string;
  /** Sizes and terms this venue is asked for each hour. */
  requests: { size: number; term: Term }[];
  /** Build the request; return null when the venue cannot be asked (no key, size above its maximum). */
  request(size: number, term: Term, ctx: CollectContext): { url: string; init: RequestInit } | { skip: string } | null;
  /** Parse the body (JSON unless `fetchOptions.expect` says otherwise); throw with a short message on drift. */
  parse(body: string, size: number, term: Term): Parsed;
  /**
   * The environment variable that must be `on` before this venue's rows count toward a print or are published
   * (src/index/gate.ts). For venues whose terms restrict automated reads or reproducing their data: they are collected
   * and stored, never published, until the gate is switched on. Absent: the venue is published like any other.
   */
  publishGate?: string;
  /** Per-venue overrides merged over `ctx.fetchOptions` for this venue's requests only (for example `{ expect: "html" }`). Timing and the fetch implementation stay the context's. */
  fetchOptions?: Pick<FetchOptions, "expect" | "maxBytes">;
}

/** A venue's raw answer, kept beside its quote rows so a parse or a rejection can be checked later: `hash` is the sha256 of the body as received, the quote's payloadHash. */
export interface Payload {
  hash: string;
  /** The body redacted with the same rule as reasons and capped at MAX_BODY_BYTES, so it may differ from what `hash` was taken over. */
  body: string;
}

/** What one adapter returns for one hour: exactly one quote per request, and one payload per quote that has a payloadHash. */
export interface Collected {
  quotes: Quote[];
  payloads: Payload[];
}

const REASON_MAX = 200;
const REDACTION_FAILED = "[redaction failed]";

function base(a: VenueAdapter, size: number, term: Term, ctx: CollectContext, source: string): Omit<Quote, "sunPerUnit" | "depth" | "status" | "reason" | "payloadHash"> {
  return { hour: ctx.hour, venue: a.venue, size, term, readAt: ctx.now, source };
}

function safeRedact(ctx: CollectContext, s: string): string {
  try {
    const r = ctx.redact(s);
    return typeof r === "string" ? r : REDACTION_FAILED;
  } catch {
    return REDACTION_FAILED;
  }
}

/** Origin and path of a URL; the query, the fragment and any credentials are dropped. Null when `s` is not an http(s) URL. */
function endpoint(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

/**
 * The published provenance of a quote. Collector URLs are constants and none carries a key in its path, so the source
 * keeps the endpoint's origin and path (the query is dropped) with every configured secret value removed, before and
 * after the cut. A source that is not a URL (the venue name, for a request never sent) has only the values removed.
 * Without a value redactor, or when it fails, the source falls back to the reason redactor (host only).
 */
function publishedSource(ctx: CollectContext, source: string): string {
  const values = ctx.redactValues;
  if (!values) return safeRedact(ctx, source);
  try {
    const first = values(source);
    if (typeof first !== "string") throw new Error("redactor returned a non-string");
    const cut = endpoint(first);
    const out = values(cut ?? first);
    if (typeof out !== "string") throw new Error("redactor returned a non-string");
    return out;
  } catch {
    return safeRedact(ctx, source);
  }
}

/** The last step for every quote: redact `source` and `reason`, then collapse whitespace and cap the reason. Redacting first so a cut never splits a secret the redactor would have caught. */
function finish(q: Quote, ctx: CollectContext): Quote {
  return {
    ...q,
    source: publishedSource(ctx, q.source),
    reason: q.reason === null ? null : safeRedact(ctx, q.reason).replace(/\s+/g, " ").slice(0, REASON_MAX),
  };
}

/** Cuts a string to at most `max` UTF-8 bytes; a character split at the cut is dropped. */
function capBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  return Buffer.from(s).subarray(0, max).toString("utf8").replace(/\uFFFD$/, "");
}

/** The stored form of a raw body: redacted like a reason (a venue could echo a key or a signed URL), then capped. */
function storedBody(ctx: CollectContext, body: string): string {
  return capBytes(safeRedact(ctx, body), MAX_BODY_BYTES);
}

/** One request: the quote, and the raw body whenever the quote carries its payloadHash (a parse failure keeps its body: it is the evidence of the drift). */
async function collectOne(a: VenueAdapter, size: number, term: Term, ctx: CollectContext): Promise<{ quote: Quote; body: string | null }> {
  const req = a.request(size, term, ctx);
  if (req === null || "skip" in req) {
    return { quote: { ...base(a, size, term, ctx, a.venue), sunPerUnit: null, depth: null, status: "missing", reason: req === null ? "venue cannot be asked for this size or term" : req.skip, payloadHash: null }, body: null };
  }
  const res = await fetchQuote(req.url, req.init, { ...ctx.fetchOptions, ...a.fetchOptions });
  const readAt = (ctx.clock ?? (() => new Date()))();
  const b = { ...base(a, size, term, ctx, req.url), readAt };
  if (!res.ok) {
    return { quote: { ...b, sunPerUnit: null, depth: null, status: "failed", reason: `${res.kind}: ${res.reason}`, payloadHash: null }, body: null };
  }
  const body = res.body;
  let parsed: Parsed;
  try {
    parsed = a.parse(res.body, size, term);
  } catch (e) {
    return { quote: { ...b, sunPerUnit: null, depth: null, status: "failed", reason: `schema: ${errorMessage(e)}`, payloadHash: res.payloadHash }, body };
  }
  const depth = parsed.depth === null ? null : Math.min(parsed.depth, size);
  if (parsed.raw === null) {
    if (depth === null || depth >= size) {
      return { quote: { ...b, sunPerUnit: null, depth: null, status: "failed", reason: "schema: no price and no depth shortfall to report", payloadHash: res.payloadHash }, body };
    }
    return { quote: { ...b, sunPerUnit: null, depth, status: "no-depth", reason: parsed.note ?? `venue can fill ${depth} of ${size} units`, payloadHash: res.payloadHash }, body };
  }
  const n = normalise(parsed.raw, ctx.energyFeeSun);
  if (!n.ok) {
    return { quote: { ...b, sunPerUnit: null, depth, status: "rejected", reason: n.reason, payloadHash: res.payloadHash }, body };
  }
  const status = depth === null ? "depth-unknown" : depth >= size ? "ok" : "no-depth";
  return { quote: { ...b, sunPerUnit: n.sunPerUnit, depth, status, reason: status === "ok" ? null : status === "no-depth" ? `venue can fill ${depth} of ${size} units` : (parsed.note ?? "venue does not report depth"), payloadHash: res.payloadHash }, body };
}

/**
 * Run one adapter for all its requests, keeping each raw body (redacted and capped) beside its quote. Never throws;
 * every request becomes exactly one Quote, and every quote with a payloadHash has one Payload with that hash.
 */
export async function collectAll(a: VenueAdapter, ctx: CollectContext): Promise<Collected> {
  const quotes: Quote[] = [];
  const payloads: Payload[] = [];
  for (const { size, term } of a.requests) {
    let q: Quote;
    let body: string | null = null;
    try {
      ({ quote: q, body } = await collectOne(a, size, term, ctx));
    } catch (e) {
      q = { ...base(a, size, term, ctx, a.venue), sunPerUnit: null, depth: null, status: "failed", reason: `error: ${errorMessage(e)}`, payloadHash: null };
    }
    const done = finish(q, ctx);
    quotes.push(done);
    if (done.payloadHash !== null && body !== null) payloads.push({ hash: done.payloadHash, body: storedBody(ctx, body) });
  }
  return { quotes, payloads };
}

/** The quotes only, for callers that keep no payloads (the smoke script). */
export async function collect(a: VenueAdapter, ctx: CollectContext): Promise<Quote[]> {
  return (await collectAll(a, ctx)).quotes;
}
