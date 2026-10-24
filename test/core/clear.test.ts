import { describe, expect, it } from "vitest";
import { clearBatch, clearCorrected } from "../../src/core/clear.js";

describe("clearBatch (the research post's rule, kept for the record)", () => {
  it("finds the highest price at which bids cover asks", () => {
    const bids = [{ priceSun: 60, energy: 10 }, { priceSun: 40, energy: 20 }, { priceSun: 30, energy: 30 }, { priceSun: 20, energy: 40 }];
    const asks = [{ priceSun: 15, energy: 20 }, { priceSun: 25, energy: 20 }, { priceSun: 35, energy: 20 }, { priceSun: 50, energy: 20 }];
    expect(clearBatch(bids, asks, 100)).toEqual({ priceSun: 30, energy: 40 });
  });
  it("clears nothing when no bid reaches an ask", () => {
    expect(clearBatch([{ priceSun: 10, energy: 10 }], [{ priceSun: 50, energy: 20 }], 100)).toEqual({ priceSun: null, energy: 0 });
  });
});

describe("clearCorrected (asks closed before reveal, cap on offered supply, reserve floor)", () => {
  const supplier = [{ priceSun: 35, energy: 200_000_000 }]; // one ask at the supplier's net JustLend alternative
  it("clears one supplier against two bidders inside the band at a positive price", () => {
    const bids = [{ priceSun: 45, energy: 20_000_000 }, { priceSun: 40, energy: 20_000_000 }];
    const r = clearCorrected(bids, supplier, { capShare: 0.35, reserveFloorSun: 35, maxBidSun: 100 });
    expect(r.priceSun).toBe(35); // excess supply: the price is the marginal ask (the supplier's reserve), not the bid
    expect(r.energy).toBe(40_000_000);
    expect(r.awards).toEqual([{ priceSun: 45, energy: 20_000_000 }, { priceSun: 40, energy: 20_000_000 }]);
  });
  it("caps one bidder at 35 % of offered supply, not of cleared energy", () => {
    const bids = [{ priceSun: 50, energy: 150_000_000 }, { priceSun: 40, energy: 20_000_000 }];
    const r = clearCorrected(bids, supplier, { capShare: 0.35, reserveFloorSun: 35, maxBidSun: 100 });
    expect(r.awards[0]).toEqual({ priceSun: 50, energy: 70_000_000 });
    expect(r.energy).toBe(90_000_000);
  });
  it("clears at the reserve floor when bids cross the ask but sit below the floor", () => {
    const bids = [{ priceSun: 36, energy: 20_000_000 }];
    const r = clearCorrected(bids, [{ priceSun: 30, energy: 100_000_000 }], { capShare: 0.35, reserveFloorSun: 35, maxBidSun: 100 });
    expect(r.priceSun).toBe(35);
  });
  it("clears nothing below the floor or when no bid reaches the ask", () => {
    const r = clearCorrected([{ priceSun: 34, energy: 20_000_000 }], supplier, { capShare: 0.35, reserveFloorSun: 35, maxBidSun: 100 });
    expect(r).toEqual({ priceSun: null, energy: 0, awards: [] });
  });
  it("never fills a bid from an ask above its price (leftover of a part-filled dearer ask)", () => {
    const r = clearCorrected(
      [{ priceSun: 50, energy: 20 }, { priceSun: 36, energy: 10 }],
      [{ priceSun: 30, energy: 10 }, { priceSun: 40, energy: 100 }],
      { capShare: 1, reserveFloorSun: 0, maxBidSun: 100 },
    );
    expect(r).toEqual({ priceSun: 40, energy: 20, awards: [{ priceSun: 50, energy: 20 }] });
  });
  it("holds its invariants over 2,000 seeded random books", () => {
    // mulberry32, seed 42: deterministic, so a failure reproduces.
    let state = 42;
    const rand = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const order = () => ({ priceSun: int(1, 120), energy: int(0, 100_000_000) });
    const many = (lo: number, hi: number) => Array.from({ length: int(lo, hi) }, order);
    const shares = [0.35, 0.5, 1];
    for (let n = 0; n < 2000; n += 1) {
      const asks = many(1, 5);
      const bids = many(1, 6);
      const capShare = shares[int(0, 2)]!;
      const reserveFloorSun = int(0, 60);
      const r = clearCorrected(bids, asks, { capShare, reserveFloorSun, maxBidSun: 100 });
      const ctx = JSON.stringify({ n, bids, asks, capShare, reserveFloorSun, r });
      const offered = asks.reduce((s, a) => s + a.energy, 0);
      expect(r.priceSun === null, ctx).toBe(r.awards.length === 0);
      expect(r.energy, ctx).toBe(r.awards.reduce((s, a) => s + a.energy, 0));
      expect(r.energy, ctx).toBeLessThanOrEqual(offered);
      for (const a of r.awards) {
        expect(a.energy, ctx).toBeLessThanOrEqual(Math.floor(offered * capShare));
        expect(a.priceSun, ctx).toBeGreaterThanOrEqual(r.priceSun as number);
      }
      if (r.priceSun !== null) {
        expect(r.priceSun, ctx).toBeGreaterThanOrEqual(reserveFloorSun);
        const askedAtOrBelow = asks.filter((a) => a.priceSun <= (r.priceSun as number)).reduce((s, a) => s + a.energy, 0);
        expect(r.energy, ctx).toBeLessThanOrEqual(askedAtOrBelow);
      }
    }
  });
});
