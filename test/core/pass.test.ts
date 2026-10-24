import { describe, expect, it } from "vitest";
import { bandPass, dailyConsumption, supplierPass, termPremium, utilisationPass } from "../../src/core/pass.js";
import type { WalletRead } from "../../src/core/pass.js";

/** Hourly reads of one wallet under java-tron's decay model: stored = stored * 23/24 + burnPerDay/24 each hour. */
function simulate(wallet: string, opts: { limit: number; burnPerDay: number; startUsed: number; reads: number; firstHour?: number }): WalletRead[] {
  const out: WalletRead[] = [];
  let used = opts.startUsed;
  for (let i = 0; i < opts.reads; i++) {
    if (i > 0) used = used * (23 / 24) + opts.burnPerDay / 24;
    out.push({ wallet, hour: (opts.firstHour ?? 0) + i, energyLimit: opts.limit, energyUsed: used });
  }
  return out;
}
const read = (hour: number, energyUsed: number, energyLimit = 2400, wallet = "w"): WalletRead => ({ wallet, hour, energyLimit, energyUsed });

describe("dailyConsumption: burn rebuilt from hourly deltas under the 24 h decay", () => {
  it("recovers a steady 100M a day from 25 decayed reads", () => {
    const r = dailyConsumption(simulate("w", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 25 }));
    expect(r.steps).toBe(24);
    expect(r.spanHours).toBe(24);
    expect(r.estimatedSteps).toBe(0);
    expect(r.units).toBeGreaterThan(99_999_000);
    expect(r.units).toBeLessThan(100_001_000);
  });
  it("reads a quiet wallet, whose usage only decays, as zero consumption", () => {
    const r = dailyConsumption(simulate("w", { limit: 300_000_000, burnPerDay: 0, startUsed: 100_000_000, reads: 25 }));
    expect(r).toMatchObject({ steps: 24, estimatedSteps: 0 });
    expect(r.units).toBeLessThan(1);
  });
  it("counts a pair more than one hour apart as estimated, and decays across the whole gap", () => {
    // 100 -> 2 h later: 100 * (1 - 2/24) = 91.666..; a read of 91.666.. + 10 means 10 burned.
    const r = dailyConsumption([read(0, 100), read(1, 100 * (23 / 24)), read(3, 100 * (23 / 24) * (22 / 24) + 10)]);
    expect(r).toMatchObject({ steps: 2, estimatedSteps: 1, spanHours: 3 });
    expect(r.units).toBeCloseTo(10, 6);
  });
  it("dedupes by hour (last wins), ignores non-finite reads and keeps the latest 25", () => {
    expect(dailyConsumption([read(0, 0), read(1, 5), read(1, 7), read(2, Number.NaN), { ...read(3, 1), energyLimit: Infinity }])).toMatchObject({ steps: 1, units: 7 });
    const many = Array.from({ length: 40 }, (_, i) => read(i, 10));
    expect(dailyConsumption(many).steps).toBe(24);
    expect(dailyConsumption([]).steps).toBe(0);
  });
  it("clamps a negative step to zero", () => {
    expect(dailyConsumption([read(0, 100), read(1, 50)]).units).toBe(0);
  });
});

describe("supplierPass: the supplier's idle energy from consumption, not the decaying snapshot", () => {
  it("passes a wallet with 300M limit burning 100M a day (idle about 200M)", () => {
    const r = supplierPass(simulate("w", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 25 }));
    expect(r.idleUnitsPerDay).toBeGreaterThanOrEqual(199_999_000);
    expect(r).toMatchObject({ pass: true, complete: true, wallets: 1 });
  });
  it("fails just under the line: 100.5M a day leaves about 199.5M", () => {
    const r = supplierPass(simulate("w", { limit: 300_000_000, burnPerDay: 100_500_000, startUsed: 100_500_000, reads: 25 }));
    expect(r.idleUnitsPerDay).toBeLessThan(199_600_000);
    expect(r.idleUnitsPerDay).toBeGreaterThan(199_400_000);
    expect(r).toMatchObject({ pass: false, complete: true });
  });
  it("fails a wallet burning its whole 500M allowance (idle about 0)", () => {
    const r = supplierPass(simulate("w", { limit: 500_000_000, burnPerDay: 500_000_000, startUsed: 500_000_000, reads: 25 }));
    expect(r.idleUnitsPerDay).toBeLessThan(1_000);
    expect(r.pass).toBe(false);
  });
  it("sums idle over wallets, and one incomplete wallet makes the result incomplete and a fail", () => {
    const a = simulate("a", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 25 });
    const b = simulate("b", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 25 });
    expect(supplierPass([...a, ...b])).toMatchObject({ pass: true, complete: true, wallets: 2 });
    expect(supplierPass([...a, ...b]).idleUnitsPerDay).toBeGreaterThanOrEqual(399_998_000);
    expect(supplierPass([...a, ...b.slice(-10)])).toMatchObject({ pass: false, complete: false, wallets: 2 });
  });
  it("with 23 steps is incomplete and not a pass, even when idle clears the line", () => {
    const r = supplierPass(simulate("w", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 24 }));
    expect(r.idleUnitsPerDay).toBeGreaterThanOrEqual(199_999_000);
    expect(r).toMatchObject({ pass: false, complete: false });
  });
  it("does not count reads every 24 hours as a full day", () => {
    const sparse = simulate("w", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 25 }).map((r, i) => ({ ...r, hour: i * 24 }));
    expect(supplierPass(sparse)).toMatchObject({ pass: false, complete: false });
  });
  it("is not a pass on empty input, and skips non-finite reads", () => {
    expect(supplierPass([])).toEqual({ pass: false, idleUnitsPerDay: 0, complete: false, wallets: 0 });
    const good = simulate("w", { limit: 300_000_000, burnPerDay: 100_000_000, startUsed: 100_000_000, reads: 25 });
    const noisy = [...good, { wallet: "w", hour: 99, energyLimit: Number.NaN, energyUsed: 0 }, { wallet: "x", hour: 1, energyLimit: Infinity, energyUsed: 0 }];
    expect(supplierPass(noisy)).toMatchObject({ pass: true, wallets: 1 });
  });
});

describe("utilisationPass: top-100 stakers, consumption over limit, full day only", () => {
  /** A steady hourly day: limit 2400, burning `ratio` of it, so the true utilisation is `ratio`. */
  const day = (ratio: number, wallet = "w"): WalletRead[] => simulate(wallet, { limit: 2400, burnPerDay: 2400 * ratio, startUsed: 2400 * ratio, reads: 25 });
  const keepHours = (reads: WalletRead[], drop: number[]) => reads.filter((r) => !drop.includes(r.hour));
  it("passes (scarcity) at 85 % and reads as a markup market below 70 %", () => {
    const at85 = utilisationPass(day(0.85));
    expect(at85).toMatchObject({ pass: true, framing: "scarcity", complete: true, wallets: 1 });
    expect(at85.utilisation).toBeCloseTo(0.85, 6);
    expect(utilisationPass(day(0.84))).toMatchObject({ pass: false, framing: "neither" });
    expect(utilisationPass(day(0.69))).toMatchObject({ pass: false, framing: "markup" });
  });
  it("reads exactly 0.70 as neither, not markup", () => {
    const r = utilisationPass(day(0.7));
    expect(r).toMatchObject({ pass: false, framing: "neither" });
    expect(r.utilisation).toBeCloseTo(0.7, 6);
  });
  it("reads a saturated network (burn = limit) as scarcity at 0.99 or more", () => {
    const r = utilisationPass(simulate("w", { limit: 300_000_000, burnPerDay: 300_000_000, startUsed: 300_000_000, reads: 25 }));
    expect(r.utilisation).toBeGreaterThanOrEqual(0.99);
    expect(r).toMatchObject({ pass: true, framing: "scarcity", complete: true });
  });
  it("reads a quiet network as markup", () => {
    const r = utilisationPass(simulate("w", { limit: 300_000_000, burnPerDay: 0, startUsed: 300_000_000, reads: 25 }));
    expect(r).toMatchObject({ pass: false, framing: "markup" });
  });
  it("sums consumption and limit across wallets", () => {
    const busy = simulate("a", { limit: 100, burnPerDay: 100, startUsed: 100, reads: 25 });
    const quiet = simulate("b", { limit: 100, burnPerDay: 0, startUsed: 0, reads: 25 });
    expect(utilisationPass([...busy, ...quiet])).toMatchObject({ complete: true, wallets: 2 });
    expect(utilisationPass([...busy, ...quiet]).utilisation).toBeCloseTo(0.5, 6);
  });
  it("does not turn a 4 % network into a scarcity pass by reading it once every 24 hours", () => {
    const every24h = simulate("w", { limit: 2400, burnPerDay: 96, startUsed: 96, reads: 25 }).map((r, i) => ({ ...r, hour: i * 24 }));
    expect(utilisationPass(every24h)).toEqual({ pass: false, framing: "insufficient", utilisation: null, complete: false, wallets: 0 });
  });
  it("is not full on reads every 2 hours over 48 hours (24 estimated hours)", () => {
    const reads = simulate("w", { limit: 2400, burnPerDay: 2400, startUsed: 2400, reads: 25 }).map((r, i) => ({ ...r, hour: i * 2 }));
    expect(dailyConsumption(reads)).toMatchObject({ steps: 24, estimatedSteps: 24, spanHours: 48 });
    expect(utilisationPass(reads)).toMatchObject({ pass: false, framing: "insufficient", complete: false, wallets: 0 });
  });
  it("is still full with one 3-hour outage in the day, and within 2 % of the truth", () => {
    // 27 hourly hours 0..26 minus hours 10 and 11 leaves 25 reads with a 9 -> 12 gap: 2 estimated hours, span 26.
    const reads = keepHours(simulate("w", { limit: 2400, burnPerDay: 1200, startUsed: 1200, reads: 27 }), [10, 11]);
    expect(reads).toHaveLength(25);
    expect(dailyConsumption(reads)).toMatchObject({ estimatedSteps: 2, spanHours: 26 });
    const r = utilisationPass(reads);
    expect(r).toMatchObject({ complete: true, wallets: 1 });
    expect(Math.abs(r.utilisation! - 0.5)).toBeLessThan(0.5 * 0.02);
  });
  it("is not full with three 2-hour gaps in the day", () => {
    const reads = keepHours(simulate("w", { limit: 2400, burnPerDay: 2400, startUsed: 2400, reads: 28 }), [5, 12, 20]);
    expect(reads).toHaveLength(25);
    expect(dailyConsumption(reads)).toMatchObject({ estimatedSteps: 3, spanHours: 27 });
    expect(utilisationPass(reads)).toMatchObject({ pass: false, framing: "insufficient", complete: false });
  });
  it("is insufficient, never a pass, with one wallet on 23 steps", () => {
    const r = utilisationPass(simulate("w", { limit: 300_000_000, burnPerDay: 300_000_000, startUsed: 300_000_000, reads: 24 }));
    expect(r).toEqual({ pass: false, framing: "insufficient", utilisation: null, complete: false, wallets: 0 });
  });
  it("is incomplete and not a pass when a saturated full wallet sits beside a 10-step one, or a single-read one", () => {
    const full = simulate("a", { limit: 300_000_000, burnPerDay: 300_000_000, startUsed: 300_000_000, reads: 25 });
    const short = simulate("b", { limit: 300_000_000, burnPerDay: 300_000_000, startUsed: 300_000_000, reads: 11 });
    expect(utilisationPass([...full, ...short])).toMatchObject({ pass: false, framing: "scarcity", complete: false, wallets: 1 });
    expect(utilisationPass([...full, read(0, 5, 2400, "c")])).toMatchObject({ pass: false, framing: "scarcity", complete: false, wallets: 1 });
  });
  it("is insufficient, never a pass, with no data or a zero total limit", () => {
    const none = { pass: false, framing: "insufficient", utilisation: null, complete: false, wallets: 0 };
    expect(utilisationPass([])).toEqual(none);
    expect(utilisationPass([read(0, 5)])).toEqual(none);
    expect(utilisationPass(simulate("w", { limit: 0, burnPerDay: 0, startUsed: 0, reads: 25 }))).toEqual(none);
    expect(utilisationPass([read(0, Number.NaN), read(1, 5)])).toEqual(none);
  });
  it("skips non-finite reads", () => {
    const reads = [...day(0.85), read(7, Number.NaN), { ...read(9, 5), energyLimit: Infinity }, read(11, Infinity)];
    expect(utilisationPass(reads)).toMatchObject({ pass: true, framing: "scarcity", complete: true });
  });
});

describe("bandPass: the cheapest 20M-depth quote against that hour's JustLend net rate", () => {
  let n = 0;
  const hour = (cheapest: number | null, net: number) => ({ hour: n++, cheapestSun: cheapest, justlendNetSun: net });
  it("passes with 12 of 24 hours at least 5 sun above the net rate and fails at 11", () => {
    const hours = [...Array.from({ length: 12 }, () => hour(40.4, 35.4)), ...Array.from({ length: 12 }, () => hour(39, 35.4))];
    expect(bandPass(hours)).toMatchObject({ pass: true, hoursAbove: 12 });
    hours[0] = { ...hour(40.3, 35.4), hour: 0 };
    expect(bandPass(hours)).toMatchObject({ pass: false, hoursAbove: 11 });
  });
  it("counts an hour with no depth-aware quote as not above", () => {
    expect(bandPass(Array.from({ length: 24 }, () => hour(null, 35.4)))).toMatchObject({ pass: false, hoursAbove: 0 });
  });
  it("is exact at 5 sun despite float noise, and rejects 4.99", () => {
    expect(35.3 - 30.3).toBeLessThan(5); // raw difference is 4.9999999999999964
    expect(bandPass(Array.from({ length: 12 }, () => hour(35.3, 30.3)))).toMatchObject({ pass: true, hoursAbove: 12 });
    expect(bandPass(Array.from({ length: 24 }, () => hour(35.29, 30.3)))).toMatchObject({ pass: false, hoursAbove: 0 });
  });
});

describe("bandPass: hardening", () => {
  it("counts only the latest 24 of 72 distinct hours but reports all 72 observed", () => {
    const hours = Array.from({ length: 72 }, (_, i) => ({ hour: i, cheapestSun: 41, justlendNetSun: 35 }));
    expect(bandPass(hours)).toMatchObject({ pass: true, hoursAbove: 24, hoursObserved: 72, complete: true });
  });
  it("takes the latest hours regardless of input order", () => {
    const old = Array.from({ length: 48 }, (_, i) => ({ hour: i, cheapestSun: 41, justlendNetSun: 35 }));
    const recent = Array.from({ length: 24 }, (_, i) => ({ hour: 100 + i, cheapestSun: 36, justlendNetSun: 35 }));
    expect(bandPass([...recent, ...old])).toMatchObject({ pass: false, hoursAbove: 0, hoursObserved: 72 });
  });
  it("counts a duplicate hour once, last row winning", () => {
    const hours = Array.from({ length: 12 }, (_, i) => ({ hour: i, cheapestSun: 41, justlendNetSun: 35 }));
    expect(bandPass([...hours, ...hours])).toMatchObject({ hoursAbove: 12, hoursObserved: 12 });
    expect(bandPass([{ hour: 1, cheapestSun: 41, justlendNetSun: 35 }, { hour: 1, cheapestSun: 36, justlendNetSun: 35 }])).toMatchObject({ hoursAbove: 0, hoursObserved: 1 });
  });
  it("is not complete with 10 hours observed", () => {
    const hours = Array.from({ length: 10 }, (_, i) => ({ hour: i, cheapestSun: 41, justlendNetSun: 35 }));
    expect(bandPass(hours)).toMatchObject({ pass: false, hoursAbove: 10, hoursObserved: 10, complete: false });
  });
  it("counts non-finite quotes or rates as not above", () => {
    const row = (i: number, cheapestSun: number | null, justlendNetSun: number) => ({ hour: i, cheapestSun, justlendNetSun });
    expect(bandPass([row(0, Infinity, 35), row(1, Number.NaN, 35), row(2, 41, Number.NaN), row(3, 41, -Infinity), row(4, 41, 35)])).toMatchObject({ hoursAbove: 1, hoursObserved: 5 });
  });
});

describe("termPremium: 7- or 14-day price per unit-day against the 1-day price per unit-day", () => {
  it("exists at 10 % and not at 9.9 %", () => {
    expect(termPremium({ d1PerDay: 40, d7PerDay: 44, d14PerDay: 41 })).toMatchObject({ exists: true, premium: 0.1 });
    expect(termPremium({ d1PerDay: 40, d7PerDay: 43.9, d14PerDay: 43.9 })).toMatchObject({ exists: false });
  });
  it("does not round 9.96 % up to 10 %", () => {
    expect(termPremium({ d1PerDay: 100, d7PerDay: 109.96, d14PerDay: null })).toMatchObject({ exists: false });
    expect(termPremium({ d1PerDay: 100, d7PerDay: 110, d14PerDay: null })).toMatchObject({ exists: true });
  });
  it("reports the premium to 4 dp; below the threshold it is rounded down, so a reported premium that does not exist is always under it", () => {
    expect(termPremium({ d1PerDay: 51, d7PerDay: 55, d14PerDay: null })).toEqual({ exists: false, premium: 0.0784 });
    expect(termPremium({ d1PerDay: 78, d7PerDay: 99, d14PerDay: null })).toEqual({ exists: true, premium: 0.2692 });
    expect(termPremium({ d1PerDay: 100, d7PerDay: 109.95, d14PerDay: null })).toEqual({ exists: false, premium: 0.0995 });
    expect(termPremium({ d1PerDay: 100, d7PerDay: 109.999, d14PerDay: null })).toEqual({ exists: false, premium: 0.0999 });
    expect(termPremium({ d1PerDay: 100, d7PerDay: 90, d14PerDay: null })).toEqual({ exists: false, premium: -0.1 });
  });
});

describe("termPremium: hardening", () => {
  it("has no premium when neither term price is usable", () => {
    expect(termPremium({ d1PerDay: 40, d7PerDay: null, d14PerDay: null })).toEqual({ exists: false, premium: null });
    expect(termPremium({ d1PerDay: 40, d7PerDay: Number.NaN, d14PerDay: Infinity })).toEqual({ exists: false, premium: null });
  });
  it("uses d14 when d7 is NaN", () => {
    expect(termPremium({ d1PerDay: 40, d7PerDay: Number.NaN, d14PerDay: 44 })).toMatchObject({ exists: true, premium: 0.1 });
  });
  it("has no premium when d1 is not a finite positive number", () => {
    for (const d1PerDay of [0, -1, Number.NaN, Infinity]) {
      expect(termPremium({ d1PerDay, d7PerDay: 44, d14PerDay: 44 })).toEqual({ exists: false, premium: null });
    }
  });
});
