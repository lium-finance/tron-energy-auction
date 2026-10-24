export interface Order {
  /** Sun per energy unit. */
  priceSun: number;
  energy: number;
}

export interface Clearing {
  priceSun: number | null;
  energy: number;
}

/**
 * The batch rule from LIUM Finance's published research post on a Tron energy auction, ported here unchanged
 * so the decision record can show the old and the corrected rule side by side. Bids above the burn price are cut
 * to it; the price is the highest at which cumulative bids cover cumulative asks.
 */
export function clearBatch(bids: readonly Order[], asks: readonly Order[], maxBidSun: number): Clearing {
  const b = bids.map((o) => ({ ...o, priceSun: Math.min(o.priceSun, maxBidSun) })).sort((x, y) => y.priceSun - x.priceSun);
  const a = [...asks].sort((x, y) => x.priceSun - y.priceSun);
  const prices = [...new Set([...b, ...a].map((o) => o.priceSun))].sort((x, y) => y - x);
  for (const p of prices) {
    const demand = b.filter((o) => o.priceSun >= p).reduce((s, o) => s + o.energy, 0);
    const supply = a.filter((o) => o.priceSun <= p).reduce((s, o) => s + o.energy, 0);
    if (supply > 0 && demand >= supply) return { priceSun: p, energy: supply };
  }
  const best = [...prices].reverse().find((p) => a.some((o) => o.priceSun <= p) && b.some((o) => o.priceSun >= p));
  if (best === undefined) return { priceSun: null, energy: 0 };
  const demand = b.filter((o) => o.priceSun >= best).reduce((s, o) => s + o.energy, 0);
  const supply = a.filter((o) => o.priceSun <= best).reduce((s, o) => s + o.energy, 0);
  return { priceSun: best, energy: Math.min(demand, supply) };
}

export interface CorrectedOptions {
  /** No bidder takes more than this share of the energy offered (not of the energy cleared). */
  capShare: number;
  /** Nothing clears below this price; a crossing below it clears at it. */
  reserveFloorSun: number;
  maxBidSun: number;
}

export interface CorrectedClearing extends Clearing {
  /** One award per bidder in bid order, after the cap, at the uniform price. */
  awards: Order[];
}

/**
 * The corrected rule, which changes the research rule in three ways: asks are fixed before bids are seen (so they are an input
 * here, not a strategy), the cap applies to offered supply, and a reserve floor replaces the quorum so a
 * one-supplier hour can clear. Uniform price: the dearest ask that was needed to fill the awards (with excess
 * supply that is the supplier's own reserve), never below the floor. Awards keep the bid's price for the record.
 *
 * Input and output contract:
 * - The caller passes one aggregated order per bidder; the cap applies per order, so two orders from one bidder
 *   would each get the full cap.
 * - Awards come back in descending bid-price order and omit bids that were not filled.
 * - An award's priceSun is the bid price after the maxBidSun cut, not the uniform price.
 * - Equal-priced bids fill in input order (the sort is stable), not pro rata.
 */
export function clearCorrected(bids: readonly Order[], asks: readonly Order[], o: CorrectedOptions): CorrectedClearing {
  const offered = asks.reduce((s, a) => s + a.energy, 0);
  const cap = Math.floor(offered * o.capShare);
  const sortedAsks = [...asks].sort((x, y) => x.priceSun - y.priceSun);
  const sortedBids = bids
    .map((b) => ({ priceSun: Math.min(b.priceSun, o.maxBidSun), energy: Math.min(b.energy, cap) }))
    .filter((b) => b.priceSun >= o.reserveFloorSun && b.energy > 0)
    .sort((x, y) => y.priceSun - x.priceSun);
  const awards: Order[] = [];
  let remaining = 0;
  let askIdx = 0;
  let currentAskPrice = 0;
  let marginalAsk: number | null = null;
  for (const bid of sortedBids) {
    let want = bid.energy;
    let got = 0;
    while (want > 0) {
      if (remaining === 0) {
        const ask = sortedAsks[askIdx];
        if (!ask) break;
        remaining = ask.energy;
        currentAskPrice = ask.priceSun;
        askIdx += 1;
      }
      // Also covers the leftover of an ask a higher bid only part-filled: a bid never takes from an ask above its price.
      if (currentAskPrice > bid.priceSun) break;
      const take = Math.min(want, remaining);
      if (take > 0) marginalAsk = currentAskPrice;
      got += take;
      want -= take;
      remaining -= take;
    }
    if (got === 0) break;
    awards.push({ priceSun: bid.priceSun, energy: got });
  }
  if (marginalAsk === null || awards.length === 0) return { priceSun: null, energy: 0, awards: [] };
  return { priceSun: Math.max(marginalAsk, o.reserveFloorSun), energy: awards.reduce((s, a) => s + a.energy, 0), awards };
}
