import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { tronpulse } from "../../src/collectors/tronpulse.js";

const fixture = readFileSync(new URL("../fixtures/tronpulse-market-settings.json", import.meta.url), "utf8");
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
type Settings = { success: unknown; data: { energy_duration: Record<string, unknown>[] } };
const edit = (f: (o: Settings) => void): string => { const o = JSON.parse(fixture) as Settings; f(o); return JSON.stringify(o); };
/** The body the book endpoints answered on 2026-10-28, as a 200: it must fail, not read as a price. */
const BOOK_503 = readFileSync(new URL("../fixtures/tronpulse-market-orders-503.html", import.meta.url), "utf8");

describe("tronpulse", () => {
  it("reads the recorded 1-hour minimum, 55 sun per unit, depth unknown, with one GET", async () => {
    const f = answer(fixture);
    const quotes = await collect(tronpulse, ctx(f));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      venue: "tronpulse", size: 20_000_000, term: "1h", sunPerUnit: 55, depth: null, status: "depth-unknown",
      reason: "minimum 1-hour buy price; no depth or 20M quote without a key", source: "https://tronpulse.io/api/energypool/market_settings",
    });
    expect(calls(f)).toHaveLength(1);
    expect(calls(f)[0]![1].method).toBe("GET");
  });
  it("has no publish gate", () => {
    expect(tronpulse.publishGate).toBeUndefined();
  });
  it.each([
    ["success false", (o: Settings) => { o.success = false; }, "schema: success is false"],
    ["no 1-hour row", (o: Settings) => { o.data.energy_duration = o.data.energy_duration.filter((d) => d.unit !== "hour" || d.value !== 1); }, "schema: expected one 1-hour energy_duration row, found 0"],
    ["the 1-hour row in other blocks", (o: Settings) => { o.data.energy_duration[0]!.block_duration = 1000; }, "schema: 1-hour row block_duration is 1000, not 1200"],
    ["a string price", (o: Settings) => { o.data.energy_duration[0]!.energy_min_price = "55"; }, "schema: 1-hour energy_min_price missing or not a positive number"],
  ])("fails with a schema reason on drift: %s", async (_n, f, reason) => {
    const [q] = await collect(tronpulse, ctx(answer(edit(f))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, reason });
  });
  it("fails on the recorded 503 page served with 200", async () => {
    const [q] = await collect(tronpulse, ctx(answer(BOOK_503)));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toMatch(/^not-json: /);
  });
});
