import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { tronbid } from "../../src/collectors/tronbid.js";

const fixture = readFileSync(new URL("../fixtures/tronbid-skus-energy.json", import.meta.url), "utf8");
const answer = (body: string): typeof fetch =>
  vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const ctx = (fetchImpl: typeof fetch): CollectContext => ({
  hour: 1, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
  fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl },
  redact: (s) => s, env: {},
});

/** The fixture with its skus replaced. */
const withSkus = (skus: unknown): string => JSON.stringify({ ...(JSON.parse(fixture) as object), skus });

describe("tronbid", () => {
  it("reads the largest 60-minute package from the recorded catalog as sun per unit, depth unknown, with one GET", async () => {
    const f = answer(fixture);
    const quotes = await collect(tronbid, ctx(f));
    // 1,048,000 units for 60 minutes at 27.55 TRX: 27.55e6 / 1,048,000 = 26.288... sun per unit.
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      venue: "tronbid", size: 20_000_000, term: "1h", sunPerUnit: 26.29, depth: null, status: "depth-unknown",
      reason: "price of the 1,048,000-unit 60-minute package; no depth or 20M quote available", source: "https://tronbid.com/api/public/quick-rent/skus?resource_type=energy",
    });
    expect(quotes[0]!.payloadHash).toHaveLength(64);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://tronbid.com/api/public/quick-rent/skus?resource_type=energy");
    expect(init.method).toBe("GET");
  });
  it("ignores 15-minute packages even when they are larger", async () => {
    const skus = [
      { energy_amount: "65000", duration_minutes: 60, price_trx: "1.700000" },
      { energy_amount: "1048000", duration_minutes: 15, price_trx: "26.490000" },
    ];
    const [q] = await collect(tronbid, ctx(answer(withSkus(skus))));
    expect(q).toMatchObject({ sunPerUnit: 26.15, status: "depth-unknown", reason: "price of the 65,000-unit 60-minute package; no depth or 20M quote available" });
  });
  it("ignores a malformed 15-minute row and a non-object row", async () => {
    const skus = [
      { energy_amount: "", duration_minutes: 15, price_trx: "-1" },
      null,
      { energy_amount: "131000", duration_minutes: 60, price_trx: "3.420000" },
    ];
    const [q] = await collect(tronbid, ctx(answer(withSkus(skus))));
    expect(q).toMatchObject({ sunPerUnit: 26.11, status: "depth-unknown" });
  });
  it("accepts rows that say resource_type energy", async () => {
    const [q] = await collect(tronbid, ctx(answer(withSkus([{ energy_amount: "65000", duration_minutes: 60, price_trx: "1.7", resource_type: "energy" }]))));
    expect(q).toMatchObject({ sunPerUnit: 26.15, status: "depth-unknown" });
  });
  it("fails when any row is for another resource", async () => {
    const skus = [
      { energy_amount: "65000", duration_minutes: 60, price_trx: "1.7" },
      { resource_amount: "5000", duration_minutes: 15, price_trx: "0.5", resource_type: "bandwidth" },
    ];
    const [q] = await collect(tronbid, ctx(answer(withSkus(skus))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toBe('schema: skus[1].resource_type is "bandwidth", not "energy"');
  });
  it("fails with a schema reason when no 60-minute package exists", async () => {
    const [q] = await collect(tronbid, ctx(answer(withSkus([{ energy_amount: "65000", duration_minutes: 15, price_trx: "1.630000" }]))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toBe("schema: no 60-minute energy package in the catalog");
  });
  it("treats a row with no duration as not a 60-minute package", async () => {
    const [q] = await collect(tronbid, ctx(answer(withSkus([{ energy_amount: "65000", price_trx: "1.7" }]))));
    expect(q!.reason).toBe("schema: no 60-minute energy package in the catalog");
  });
  it("fails with a schema reason when skus is missing", async () => {
    const [q] = await collect(tronbid, ctx(answer('{"totalCount":0}')));
    expect(q!.reason).toBe("schema: skus missing or not an array");
  });
  it.each([
    ["a missing price", { energy_amount: "65000", duration_minutes: 60 }, "price_trx"],
    ["a zero price", { energy_amount: "65000", duration_minutes: 60, price_trx: "0" }, "price_trx"],
    ["a negative amount", { energy_amount: "-65000", duration_minutes: 60, price_trx: "1.7" }, "energy_amount"],
    ["a non-numeric amount", { energy_amount: "lots", duration_minutes: 60, price_trx: "1.7" }, "energy_amount"],
  ])("fails with a schema reason on %s", async (_name, sku, field) => {
    const [q] = await collect(tronbid, ctx(answer(withSkus([sku]))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toBe(`schema: skus[0].${field} missing or not a positive number`);
  });
});
