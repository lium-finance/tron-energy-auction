import { describe, expect, it } from "vitest";
import { isDepthAware, isLive, print } from "../../src/core/print.js";
import type { Quote } from "../../src/core/types.js";

const now = new Date("2026-10-28T14:00:30Z");
const hour = 497_870; // any fixed unix hour; the rule never derives it

function q(venue: string, sun: number | null, over: Partial<Quote> = {}): Quote {
  return {
    hour, venue, size: 20_000_000, term: "1h", sunPerUnit: sun, depth: 20_000_000,
    readAt: new Date("2026-10-28T14:00:12Z"), source: "test", status: "ok", reason: null, payloadHash: null, ...over,
  };
}

describe("print", () => {
  it("takes the median of live quotes at the 20M step, cheapest and dearest", () => {
    const p = print([q("a", 30), q("b", 40), q("c", 35), q("d", 60)], { now, hour });
    expect(p).toMatchObject({ median: 37.5, cheapest: 30, dearest: 60, liveCount: 4, depthAwareCount: 4, status: "live" });
  });
  it("rounds median, cheapest and dearest to the four decimals the table stores", () => {
    const p = print([q("a", 30.01), q("b", 30.02), q("c", 30.123456), q("d", 30.99996)], { now, hour });
    expect(p.median).toBe(30.0717); // (30.02 + 30.123456) / 2 = 30.071728
    expect(p.cheapest).toBe(30.01);
    expect(p.dearest).toBe(31); // 30.99996 rounds up
  });
  it("does not carry float noise into the median of two middle values", () => {
    // (30.11 + 30.12) / 2 is 30.115000000000002 and (41.3 + 41.4) / 2 is 41.349999999999994 in floating point.
    expect(print([q("a", 1), q("b", 30.11), q("c", 30.12), q("d", 99)], { now, hour }).median).toBe(30.115);
    expect(print([q("a", 1), q("b", 41.3), q("c", 41.4), q("d", 99)], { now, hour }).median).toBe(41.35);
  });
  it("ignores the 5M and 50M steps, other terms, and quotes that are not ok", () => {
    const p = print([
      q("a", 30), q("a", 25, { size: 5_000_000 }), q("a", 32, { size: 50_000_000 }),
      q("b", 40), q("b", 44, { term: "1d" }),
      q("c", 35), q("d", 99, { status: "failed", sunPerUnit: null }),
    ], { now, hour });
    expect(p).toMatchObject({ median: 35, liveCount: 3, status: "live" });
  });
  it("excludes a quote exactly 60 minutes old and keeps one at 59:59", () => {
    const stale = q("a", 30, { readAt: new Date("2026-10-28T13:00:30Z") });
    const fresh = q("b", 40, { readAt: new Date("2026-10-28T13:00:31Z") });
    const p = print([stale, fresh, q("c", 35), q("d", 36)], { now, hour });
    expect(p.liveCount).toBe(3);
    expect(p.median).toBe(36);
  });
  it("keeps only the latest quote per venue in the hour", () => {
    const early = q("a", 30, { readAt: new Date("2026-10-28T14:00:01Z") });
    const late = q("a", 50, { readAt: new Date("2026-10-28T14:00:20Z") });
    const p = print([early, late, q("b", 40), q("c", 45)], { now, hour });
    expect(p).toMatchObject({ median: 45, liveCount: 3 });
  });
  it("is thin with fewer than three live quotes but three depth-aware venues", () => {
    const p = print([q("a", 30), q("b", 40), q("c", null, { status: "failed", depth: 20_000_000 })], { now, hour });
    expect(p).toMatchObject({ median: 35, liveCount: 2, status: "thin" });
  });
  it("publishes no median when fewer than three venues can fill 20M units", () => {
    const p = print([q("a", 30), q("b", 40), q("c", 35, { depth: 5_000_000, status: "no-depth" })], { now, hour });
    expect(p).toMatchObject({ median: null, cheapest: 30, dearest: 40, liveCount: 2, depthAwareCount: 2, status: "no_index" });
  });
  it("still prints when every venue failed", () => {
    const p = print([q("a", null, { status: "failed", depth: null })], { now, hour });
    expect(p).toMatchObject({ median: null, liveCount: 0, depthAwareCount: 0, status: "no_index", hour });
    expect(p.printedAt).toBe(now);
  });

  it("does not count NaN, Infinity or zero prices as live", () => {
    const p = print([q("a", Number.NaN), q("b", Number.POSITIVE_INFINITY), q("c", 0), q("d", 40)], { now, hour });
    expect(p).toMatchObject({ median: 40, cheapest: 40, dearest: 40, liveCount: 1, depthAwareCount: 4, status: "thin" });
  });
  it("does not count a quote read after now", () => {
    const future = q("a", 30, { readAt: new Date("2026-10-28T14:00:31Z") });
    const p = print([future, q("b", 40), q("c", 35), q("d", 36)], { now, hour });
    expect(p).toMatchObject({ liveCount: 3, median: 36 });
  });
  it("ignores quotes stamped with another hour", () => {
    const p = print([q("a", 30, { hour: hour - 1 }), q("b", 40), q("c", 35), q("d", 36)], { now, hour });
    expect(p).toMatchObject({ liveCount: 3, depthAwareCount: 3, median: 36 });
  });
  it("lets a venue's later failed quote replace its earlier ok one", () => {
    const ok = q("a", 30, { readAt: new Date("2026-10-28T14:00:05Z") });
    const failed = q("a", null, { status: "failed", depth: null, readAt: new Date("2026-10-28T14:00:20Z") });
    const p = print([ok, failed, q("b", 40), q("c", 35)], { now, hour });
    expect(p).toMatchObject({ liveCount: 2, depthAwareCount: 2, status: "no_index", median: null });
  });
  it("is thin with a null median when three deep venues were all rejected", () => {
    const rej = (v: string) => q(v, null, { status: "rejected" });
    const p = print([rej("a"), rej("b"), rej("c")], { now, hour });
    expect(p).toMatchObject({ median: null, cheapest: null, dearest: null, liveCount: 0, depthAwareCount: 3, status: "thin" });
  });
  it("prints no_index with zero counts for an empty list", () => {
    const p = print([], { now, hour });
    expect(p).toMatchObject({ median: null, cheapest: null, dearest: null, liveCount: 0, depthAwareCount: 0, status: "no_index", hour });
  });
});

describe("isDepthAware and isLive", () => {
  it("agree with print: the depth-aware count is the number of quotes isDepthAware accepts", () => {
    const quotes = [q("a", 30), q("b", 40, { depth: null, status: "depth-unknown" }), q("c", 35, { depth: 5_000_000 }), q("d", 50, { status: "rejected", sunPerUnit: null })];
    const p = print(quotes, { now, hour });
    expect(p.depthAwareCount).toBe(quotes.filter((x) => isDepthAware(x)).length);
    expect(p.liveCount).toBe(quotes.filter((x) => isLive(x, now)).length);
    expect([isDepthAware(quotes[0]!), isDepthAware(quotes[1]!), isDepthAware(quotes[2]!), isDepthAware(quotes[3]!)]).toEqual([true, false, false, true]);
    expect(isLive(quotes[3]!, now)).toBe(false);
  });
  it("is not depth-aware for another size or term, and not live when stale or in the future", () => {
    expect(isDepthAware(q("a", 30, { size: 5_000_000 }))).toBe(false);
    expect(isDepthAware(q("a", 30, { term: "1d" }))).toBe(false);
    expect(isLive(q("a", 30, { readAt: new Date("2026-10-28T13:00:00Z") }), now)).toBe(false);
    expect(isLive(q("a", 30, { readAt: new Date("2026-10-28T14:01:00Z") }), now)).toBe(false);
  });
});
