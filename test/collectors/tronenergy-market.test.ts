import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { temHourSunPerUnit, tronenergyMarket } from "../../src/collectors/tronenergy-market.js";

const fixture = readFileSync(new URL("../fixtures/tronenergy-market-info.json", import.meta.url), "utf8");
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
type Info = { market: { availableEnergyByPrice: { price: number; value: number }[] }; price: { openEnergy: Record<string, number>[] }; order: { openDurations: number[] } };
const edit = (f: (o: Info) => void): string => { const o = JSON.parse(fixture) as Info; f(o); return JSON.stringify(o); };

describe("tronenergy-market", () => {
  it("converts sun per day to 1h sun per unit with the extra-day rule (40/day is 41.67, a live 1h fill)", () => {
    expect(temHourSunPerUnit(40) * 200_000).toBeCloseTo(8_333_333.33, 1);
    expect(temHourSunPerUnit(30)).toBe(31.25);
  });
  it("reads the recorded ladder: 20M fills at the 30 sun/day level, 31.25 sun 1h, depth 86,274,460, ok, with one GET", async () => {
    const f = answer(fixture);
    const quotes = await collect(tronenergyMarket, ctx(f));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      venue: "tronenergy-market", size: 20_000_000, term: "1h", sunPerUnit: 31.25, depth: 20_000_000, status: "ok",
      source: "https://api.tronenergy.market/info",
    });
    expect(calls(f)).toHaveLength(1);
    expect(calls(f)[0]![1].method).toBe("GET");
  });
  it("walks to the marginal level when the cheapest is short, whatever the order of the ladder", async () => {
    const body = edit((o) => { o.market.availableEnergyByPrice = [{ price: 40, value: 50_000_000 }, { price: 30, value: 12_000_000 }, { price: 35, value: 5_000_000 }]; });
    const [q] = await collect(tronenergyMarket, ctx(answer(body)));
    // 12M at 30 + 5M at 35 = 17M, so the 40 level is needed: 40 × 90000/86400 = 41.67.
    expect(q).toMatchObject({ sunPerUnit: 41.67, depth: 20_000_000, status: "ok" });
  });
  it("never prices below the 1h minimum pool price", async () => {
    const body = edit((o) => { o.market.availableEnergyByPrice = [{ price: 20, value: 30_000_000 }]; });
    const [q] = await collect(tronenergyMarket, ctx(answer(body)));
    expect(q).toMatchObject({ sunPerUnit: 31.25, status: "ok" });
  });
  it("is no-depth at the dearest level when the whole ladder is short", async () => {
    const body = edit((o) => { o.market.availableEnergyByPrice = [{ price: 30, value: 4_000_000 }, { price: 50, value: 6_000_000.5 }]; });
    const [q] = await collect(tronenergyMarket, ctx(answer(body)));
    expect(q).toMatchObject({ sunPerUnit: 52.08, depth: 10_000_000, status: "no-depth", reason: "venue can fill 10000000 of 20000000 units" });
  });
  it("declares the PUBLISH_TRONENERGY_MARKET gate", () => {
    expect(tronenergyMarket.publishGate).toBe("PUBLISH_TRONENERGY_MARKET");
  });
  it.each([
    ["the ladder renamed", (o: Info) => { (o.market as Record<string, unknown>).byPrice = o.market.availableEnergyByPrice; delete (o.market as Partial<Info["market"]>).availableEnergyByPrice; }, "schema: market.availableEnergyByPrice missing or not an array"],
    ["an empty ladder", (o: Info) => { o.market.availableEnergyByPrice = []; }, "schema: market.availableEnergyByPrice is empty"],
    ["a string price on a level", (o: Info) => { (o.market.availableEnergyByPrice[0] as Record<string, unknown>).price = "30"; }, "schema: market.availableEnergyByPrice[0].price missing or not a number"],
    ["no open-energy row for 1h", (o: Info) => { o.price.openEnergy = o.price.openEnergy.filter((r) => r.minDuration! > 3600); }, "schema: no price.openEnergy row for a 3600s order"],
    ["1h no longer offered", (o: Info) => { o.order.openDurations = o.order.openDurations.filter((d) => d !== 3600); }, "schema: order.openDurations does not offer 3600s"],
  ])("fails with a schema reason on drift: %s", async (_n, f, reason) => {
    const [q] = await collect(tronenergyMarket, ctx(answer(edit(f))));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, depth: null, reason });
  });
  it("fails on an HTML error page served with 200", async () => {
    const [q] = await collect(tronenergyMarket, ctx(answer(ERROR_PAGE)));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toMatch(/^not-json: /);
  });
});
