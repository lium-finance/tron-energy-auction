import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { tronzap } from "../../src/collectors/tronzap.js";

const fixture = readFileSync(new URL("../fixtures/tronzap-rates.json", import.meta.url), "utf8");
const answer = (body: string): typeof fetch =>
  vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const ctx = (fetchImpl: typeof fetch): CollectContext => ({
  hour: 1, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
  fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl },
  redact: (s) => s, env: {},
});
const calls = (f: typeof fetch) => (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
/** An HTML error page served with status 200, as a CDN or maintenance page would be. */
const ERROR_PAGE = "<!DOCTYPE html><html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center></body></html>";
const edit = (f: (o: Record<string, unknown>) => void): string => { const o = JSON.parse(fixture) as Record<string, unknown>; f(o); return JSON.stringify(o); };

describe("tronzap", () => {
  it("reads the recorded 65k price as 1h sun per unit, depth unknown, with one GET", async () => {
    const f = answer(fixture);
    const quotes = await collect(tronzap, ctx(f));
    // 2.45 TRX for 65,000 units: 2.45e6 / 65,000 = 37.69 sun per unit.
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      venue: "tronzap", size: 20_000_000, term: "1h", sunPerUnit: 37.69, depth: null, status: "depth-unknown",
      reason: "price of one 65,000-unit transfer for 1 hour; no depth or 20M quote without a key", source: "https://tronzap.com/api/rates",
    });
    expect(calls(f)).toHaveLength(1);
    expect(calls(f)[0]![1].method).toBe("GET");
  });
  it("has no publish gate", () => {
    expect(tronzap.publishGate).toBeUndefined();
  });
  it.each([
    ["price_65k missing", (o: Record<string, unknown>) => { delete o.price_65k; }, "schema: price_65k missing or not a positive number"],
    ["price_65k a string", (o: Record<string, unknown>) => { o.price_65k = "2.45"; }, "schema: price_65k missing or not a positive number"],
    ["price_131k below price_65k", (o: Record<string, unknown>) => { o.price_131k = 2; }, "schema: price_131k 2 is below price_65k 2.45"],
  ])("fails with a schema reason on drift: %s", async (_n, f, reason) => {
    const [q] = await collect(tronzap, ctx(answer(edit(f))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, reason });
  });
  it("fails on an HTML error page served with 200", async () => {
    const [q] = await collect(tronzap, ctx(answer(ERROR_PAGE)));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toMatch(/^not-json: /);
  });
});
