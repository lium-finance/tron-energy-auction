import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collect, type CollectContext, type VenueAdapter } from "../../src/collectors/adapter.js";
import { tronsave } from "../../src/collectors/tronsave.js";

const fixture = readFileSync(new URL("../fixtures/tronsave-20m-1h.json", import.meta.url), "utf8");

function ctx(fetchImpl: typeof fetch, over: Partial<CollectContext> = {}): CollectContext {
  return {
    hour: 497_870, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
    fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl }, redact: (s) => s, env: {}, ...over,
  };
}

/** Answers like TronSave: the price depends on the durationSec in the request body. */
const byDuration = (prices: Record<number, number>, available = 20_000_000): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const durationSec = (JSON.parse(String(init?.body)) as { durationSec: number }).durationSec;
    const body = { error: false, message: "Success", data: { unitPrice: prices[durationSec], durationSec, availableResource: available } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

/** A one-request adapter whose parse and request are supplied by the test. */
const stub = (over: Partial<VenueAdapter> = {}): VenueAdapter => ({
  venue: "stub",
  requests: [{ size: 20_000_000, term: "1h" }],
  request: () => ({ url: "https://stub.test/q?key=SECRET", init: {} }),
  parse: () => ({ raw: { kind: "sunPerUnit", value: 60, term: "1h" }, depth: 20_000_000 }),
  ...over,
});

const answer = (body: string, status = 200, type = "application/json"): typeof fetch =>
  (async () => new Response(body, { status, headers: { "content-type": type } })) as unknown as typeof fetch;

describe("tronsave", () => {
  it("asks 5M, 20M and 50M for 1h and the three term sizes, and parses sun per unit and depth", async () => {
    const quotes = await collect(tronsave, ctx(answer(fixture)));
    expect(quotes.map((q) => [q.size, q.term])).toEqual([
      [5_000_000, "1h"], [20_000_000, "1h"], [50_000_000, "1h"], [20_000_000, "1d"], [20_000_000, "7d"], [20_000_000, "14d"],
    ]);
    const q20 = quotes[1]!;
    expect(q20).toMatchObject({ venue: "tronsave", sunPerUnit: 60.5, depth: 20_000_000, status: "ok", reason: null });
    expect(q20.payloadHash).toHaveLength(64);
    // The fixture says 20M available, so the 50M step is no-depth at 20M.
    expect(quotes[2]).toMatchObject({ status: "no-depth", depth: 20_000_000 });
  });
  it("sends the documented request body", async () => {
    const r = tronsave.request(20_000_000, "7d", ctx(answer(fixture)));
    expect(r && "url" in r && r.url).toBe("https://api.tronsave.io/v2/estimate-buy-resource");
    expect(r && "init" in r && JSON.parse(String(r.init.body))).toEqual({ resourceAmount: 20_000_000, resourceType: "ENERGY", durationSec: 604_800, unitPrice: "MEDIUM" });
  });
  it("treats a drifted field as a schema failure with the reason", async () => {
    const quotes = await collect(tronsave, ctx(answer('{"error":false,"data":{"price":60.5}}')));
    expect(quotes[1]).toMatchObject({ status: "failed" });
    expect(quotes[1]!.reason).toMatch(/^schema: /);
  });
  it("records a venue error as failed", async () => {
    const quotes = await collect(tronsave, ctx(answer('{"error":true,"message":"Insufficient resource"}')));
    expect(quotes[1]!.status).toBe("failed");
    expect(quotes[1]!.reason).toBe("schema: venue error: Insufficient resource");
  });
  it("prices the 1d, 7d and 14d series from each response", async () => {
    const quotes = await collect(tronsave, ctx(byDuration({ 3600: 60.5, 86_400: 86.5, 604_800: 42.25, 1_209_600: 30 })));
    expect(quotes.slice(3).map((q) => [q.term, q.sunPerUnit, q.status])).toEqual([
      ["1d", 86.5, "ok"], ["7d", 42.25, "ok"], ["14d", 30, "ok"],
    ]);
  });
  it("fails a response whose durationSec is not the one asked for", async () => {
    const quotes = await collect(tronsave, ctx(answer(fixture)));
    expect(quotes[4]).toMatchObject({ term: "7d", status: "failed", sunPerUnit: null });
    expect(quotes[4]!.reason).toBe("schema: durationSec 3600 does not match the requested 604800");
  });
  it("fails a negative availableResource", async () => {
    const quotes = await collect(tronsave, ctx(answer('{"error":false,"data":{"unitPrice":60.5,"availableResource":-1}}')));
    expect(quotes[1]).toMatchObject({ status: "failed", depth: null });
    expect(quotes[1]!.reason).toMatch(/^schema: data\.availableResource/);
  });
  it("treats invalid JSON as a schema failure", async () => {
    const quotes = await collect(tronsave, ctx(answer('{"error":false,')));
    expect(quotes[1]).toMatchObject({ status: "failed" });
    expect(quotes[1]!.reason).toMatch(/^schema: /);
  });
  it("clamps depth to the size asked for and calls it ok", async () => {
    const quotes = await collect(tronsave, ctx(answer(fixture)));
    expect(quotes[0]).toMatchObject({ size: 5_000_000, depth: 5_000_000, status: "ok", reason: null });
  });
});

describe("collect", () => {
  it("records HTTP 500, a non-JSON body and a timeout as failed with no payload hash", async () => {
    const five = await collect(stub(), ctx(answer("oops", 500, "text/plain")));
    expect(five[0]).toMatchObject({ status: "failed", payloadHash: null });
    expect(five[0]!.reason).toMatch(/^upstream: 500/);
    const html = await collect(stub(), ctx(answer("<html>", 200, "text/html")));
    expect(html[0]).toMatchObject({ status: "failed", payloadHash: null });
    expect(html[0]!.reason).toMatch(/^not-json: /);
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const slow = await collect(stub(), ctx(hang, { fetchOptions: { budgetMs: 60, retryAtMs: 20, fetchImpl: hang } }));
    expect(slow[0]).toMatchObject({ status: "failed", payloadHash: null });
    expect(slow[0]!.reason).toMatch(/^timeout: /);
  });
  it("rejects a price above the energy fee and keeps the clamped depth", async () => {
    const a = stub({ parse: () => ({ raw: { kind: "sunPerUnit", value: 150, term: "1h" }, depth: 30_000_000 }) });
    const [q] = await collect(a, ctx(answer("{}")));
    expect(q).toMatchObject({ status: "rejected", sunPerUnit: null, depth: 20_000_000 });
    expect(q!.payloadHash).toHaveLength(64);
    expect(q!.reason).toMatch(/above the energy fee/);
  });
  it("marks a venue that reports no depth as depth-unknown, with its price", async () => {
    const a = stub({ parse: () => ({ raw: { kind: "sunPerUnit", value: 60, term: "1h" }, depth: null }) });
    const [q] = await collect(a, ctx(answer("{}")));
    expect(q).toMatchObject({ status: "depth-unknown", sunPerUnit: 60, depth: null, reason: "venue does not report depth" });
  });
  it("records null and skip requests as missing, stamped with ctx.now", async () => {
    const c = ctx(answer("{}"), { clock: () => new Date("2030-01-01T00:00:00Z") });
    const [none] = await collect(stub({ request: () => null }), c);
    const [skip] = await collect(stub({ request: () => ({ skip: "no key" }) }), c);
    expect(none).toMatchObject({ status: "missing", payloadHash: null, source: "stub" });
    expect(skip).toMatchObject({ status: "missing", reason: "no key" });
    expect(none!.readAt).toBe(c.now);
    expect(skip!.readAt).toBe(c.now);
  });
  it("uses the parser's note as the depth-unknown reason, redacted and capped", async () => {
    const redact = (s: string): string => s.replaceAll("SECRET", "[x]");
    const a = stub({ parse: () => ({ raw: { kind: "sunPerUnit", value: 60, term: "1h" }, depth: null, note: "price of the SECRET\npackage " + "n".repeat(300) }) });
    const [q] = await collect(a, ctx(answer("{}"), { redact }));
    expect(q).toMatchObject({ status: "depth-unknown", sunPerUnit: 60 });
    expect(q!.reason).toMatch(/^price of the \[x\] package n+$/);
    expect(q!.reason!.length).toBe(200);
    const withDepth = stub({ parse: () => ({ raw: { kind: "sunPerUnit", value: 60, term: "1h" }, depth: 20_000_000, note: "ignored" }) });
    const [ok] = await collect(withDepth, ctx(answer("{}")));
    expect(ok).toMatchObject({ status: "ok", reason: null });
  });
  it("returns too-large for an HTML body just over an adapter's maxBytes with expect html", async () => {
    const body = "<html>" + "x".repeat(95) + "</html>"; // 108 bytes
    const a = stub({ fetchOptions: { expect: "html", maxBytes: 107 } });
    const [over] = await collect(a, ctx(answer(body, 200, "text/html")));
    expect(over).toMatchObject({ status: "failed", payloadHash: null, reason: "too-large: body larger than 107 bytes" });
    const [fits] = await collect(stub({ fetchOptions: { expect: "html", maxBytes: 108 } }), ctx(answer(body, 200, "text/html")));
    expect(fits).toMatchObject({ status: "ok" });
  });
  it("takes readAt from the injected clock after the fetch", async () => {
    const at = new Date("2026-10-28T14:00:07Z");
    const [q] = await collect(stub(), ctx(answer("{}"), { clock: () => at }));
    expect(q).toMatchObject({ status: "ok" });
    expect(q!.readAt).toBe(at);
  });
  it("applies redact to every reason and source, and caps and flattens the reason", async () => {
    const redact = (s: string): string => s.replaceAll("SECRET", "[x]");
    const a = stub({ parse: () => { throw new Error("bad SECRET\nvalue " + "z".repeat(500)); } });
    const [q] = await collect(a, ctx(answer("{}"), { redact }));
    expect(q!.source).toBe("https://stub.test/q?key=[x]");
    expect(q!.reason).toMatch(/^schema: bad \[x\] value z+$/);
    expect(q!.reason!.length).toBe(200);
    const [h] = await collect(stub(), ctx(answer("nope", 500), { redact }));
    expect(h!.source).toBe("https://stub.test/q?key=[x]");
  });
  it("uses a placeholder when redact throws", async () => {
    const redact = (): string => { throw new Error("boom"); };
    const [q] = await collect(stub({ parse: () => { throw new Error("x"); } }), ctx(answer("{}"), { redact }));
    expect(q).toMatchObject({ status: "failed", reason: "[redaction failed]", source: "[redaction failed]" });
  });
  it("merges an adapter's fetchOptions over ctx.fetchOptions for that adapter only", async () => {
    const f = answer("<html>price</html>", 200, "text/html");
    const htmlVenue = stub({ fetchOptions: { expect: "html" }, parse: () => ({ raw: { kind: "sunPerUnit", value: 60, term: "1h" }, depth: 20_000_000 }) });
    const c = ctx(f);
    const [h] = await collect(htmlVenue, c);
    expect(h).toMatchObject({ status: "ok", sunPerUnit: 60 });
    const [j] = await collect(stub(), c);
    expect(j).toMatchObject({ status: "failed" });
    expect(j!.reason).toMatch(/^not-json: /);
    expect(c.fetchOptions).toEqual({ budgetMs: 1000, retryAtMs: 500, fetchImpl: f });
  });
  it("turns a throwing request() into a failed quote instead of throwing", async () => {
    const a = stub({ request: () => { throw new Error("boom"); } });
    const [q] = await collect(a, ctx(answer("{}")));
    expect(q).toMatchObject({ status: "failed", reason: "error: boom", payloadHash: null });
  });
});
