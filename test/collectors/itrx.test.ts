import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { itrx } from "../../src/collectors/itrx.js";

const fixture = readFileSync(new URL("../fixtures/itrx-index-data.json", import.meta.url), "utf8");
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

describe("itrx", () => {
  it("reads the recorded catalog: 35 sun for 1h, 12,387,503 units available, so no-depth for 20M, with one keyless GET", async () => {
    const f = answer(fixture);
    const quotes = await collect(itrx, ctx(f));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      venue: "itrx", size: 20_000_000, term: "1h", sunPerUnit: 35, depth: 12_387_503, status: "no-depth",
      reason: "venue can fill 12387503 of 20000000 units", source: "https://itrx.io/api/v1/frontend/index-data",
    });
    expect(quotes[0]!.payloadHash).toHaveLength(64);
    expect(calls(f)).toHaveLength(1);
    const [url, init] = calls(f)[0]!;
    expect(url).toBe("https://itrx.io/api/v1/frontend/index-data");
    expect(init.method).toBe("GET");
    expect(Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase())).not.toContain("api-key");
  });
  it("is ok when the platform can deliver the instrument", async () => {
    const [q] = await collect(itrx, ctx(answer(edit((o) => { o.platform_avail_energy = 25_000_000; }))));
    expect(q).toMatchObject({ sunPerUnit: 35, depth: 20_000_000, status: "ok" });
  });
  it("caps depth at the maximum order", async () => {
    const [q] = await collect(itrx, ctx(answer(edit((o) => { o.platform_avail_energy = 25_000_000; o.maximum_order_energy = 15_000_000; }))));
    expect(q).toMatchObject({ depth: 15_000_000, status: "no-depth" });
  });
  it("declares the PUBLISH_ITRX gate", () => {
    expect(itrx.publishGate).toBe("PUBLISH_ITRX");
  });
  it("fails when g1h and the period-0 tier disagree", async () => {
    const [q] = await collect(itrx, ctx(answer(edit((o) => { o.g1h = 36; }))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, reason: "schema: g1h 36 does not match tiered_pricing period 0 price 35" });
  });
  it("still reads the tier when g1h is absent", async () => {
    const [q] = await collect(itrx, ctx(answer(edit((o) => { delete o.g1h; }))));
    expect(q).toMatchObject({ sunPerUnit: 35, status: "no-depth" });
  });
  it.each([
    ["no period-0 tier", (o: Record<string, unknown>) => { o.tiered_pricing = [{ period: 1, price: 100 }]; }, "schema: expected one tiered_pricing row for period 0, found 0"],
    ["tiered_pricing renamed", (o: Record<string, unknown>) => { o.tiers = o.tiered_pricing; delete o.tiered_pricing; }, "schema: tiered_pricing missing or not an array"],
    ["a string price", (o: Record<string, unknown>) => { o.tiered_pricing = [{ period: 0, price: "35" }]; }, "schema: price missing or not a number"],
    ["availability missing", (o: Record<string, unknown>) => { delete o.platform_avail_energy; }, "schema: platform_avail_energy missing or not a number"],
  ])("fails with a schema reason on drift: %s", async (_n, f, reason) => {
    const [q] = await collect(itrx, ctx(answer(edit(f))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, depth: null, reason });
  });
  it("fails on the key error answer", async () => {
    const [q] = await collect(itrx, ctx(answer('{"detail":"API not found"}')));
    expect(q).toMatchObject({ status: "failed", reason: "schema: venue error: API not found" });
  });
  it("fails on an HTML error page served with 200", async () => {
    const [q] = await collect(itrx, ctx(answer(ERROR_PAGE)));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toMatch(/^not-json: /);
  });
});
