import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const INFO = "https://api.tronenergy.market/info";
const TERM_SECONDS = INSTRUMENT.termHours * 3600;
const DAY_SECONDS = 86_400;

export const TRONENERGY_MARKET_PUBLISH_GATE = "PUBLISH_TRONENERGY_MARKET";

/**
 * TEM bills a rental shorter than a day as a day plus its own length: payment = price × amount × (duration + 86400) / 86400
 * (tronenergymarket/tronenergy-api-examples nodejs/buy-market.js, read 2026-10-28; checked on a completed 1h order:
 * 40 sun/day × 200,000 × 90,000 / 86,400 = 8,333,333 sun). So 1h sun per unit = daily price × 90,000 / 86,400.
 */
export const temHourSunPerUnit = (sunPerDay: number): number => (sunPerDay * (TERM_SECONDS + DAY_SECONDS)) / DAY_SECONDS;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function finite(o: Record<string, unknown>, where: string, name: string): number {
  const v = o[name];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}.${name} missing or not a number`);
  return v;
}

/** The open-energy minimum pool price for the 1h term: the row with the largest `minDuration` not above it. */
function hourFloor(price: unknown): number {
  if (!isObj(price) || !Array.isArray(price.openEnergy)) throw new Error("price.openEnergy missing or not an array");
  let best: { minDuration: number; floor: number } | null = null;
  for (const [i, r] of (price.openEnergy as unknown[]).entries()) {
    if (!isObj(r)) throw new Error(`price.openEnergy[${i}] is not an object`);
    const minDuration = finite(r, `price.openEnergy[${i}]`, "minDuration");
    const floor = finite(r, `price.openEnergy[${i}]`, "minPoolPrice");
    if (minDuration <= TERM_SECONDS && (best === null || minDuration > best.minDuration)) best = { minDuration, floor };
  }
  if (best === null) throw new Error(`no price.openEnergy row for a ${TERM_SECONDS}s order`);
  if (!(best.floor > 0)) throw new Error("price.openEnergy minPoolPrice is not positive");
  return best.floor;
}

/**
 * TRON Energy Market's keyless `/info` (recorded 2026-10-28 in docs/verification/venue-apis-2026-10-28.md; fixture
 * test/fixtures/tronenergy-market-info.json). `market.availableEnergyByPrice` is the pools' delegatable energy by
 * the minimum price each pool accepts, in sun per unit per day. An order at one price fills from every pool at or
 * below it, so the row walks the ladder cheapest first until the instrument is covered: the price is that marginal
 * level (never below the 1h `price.openEnergy` minPoolPrice, the lowest price TEM accepts for the term), converted to
 * 1h sun per unit with the extra-day rule above, and the depth is the energy at or below it. A ladder short of the
 * instrument gives its whole total as depth and its dearest level as price, so the row is `no-depth`.
 * The ladder is pool supply for all durations; whether every pool takes a 1h order is not published.
 *
 * Collect-only: TEM's terms ("You will not use any automated means to access our systems", modal on
 * tronenergy.market, read 2026-10-28) restrict this read, so the rows are stored and never counted or published
 * until PUBLISH_TRONENERGY_MARKET=on (src/index/gate.ts).
 */
export const tronenergyMarket: VenueAdapter = {
  venue: "tronenergy-market",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  publishGate: TRONENERGY_MARKET_PUBLISH_GATE,
  request() {
    return { url: INFO, init: { method: "GET", headers: { accept: "application/json", "user-agent": "Mozilla/5.0 tron-energy-index" } } };
  },
  parse(body, size): Parsed {
    const b = JSON.parse(body) as unknown;
    if (!isObj(b)) throw new Error("body is not an object");
    if (!isObj(b.market)) throw new Error("market missing or not an object");
    const ladder = b.market.availableEnergyByPrice;
    if (!Array.isArray(ladder)) throw new Error("market.availableEnergyByPrice missing or not an array");
    if (isObj(b.order) && Array.isArray(b.order.openDurations) && !(b.order.openDurations as unknown[]).includes(TERM_SECONDS)) {
      throw new Error(`order.openDurations does not offer ${TERM_SECONDS}s`);
    }
    const floor = hourFloor(b.price);
    const levels = (ladder as unknown[]).map((l, i) => {
      if (!isObj(l)) throw new Error(`market.availableEnergyByPrice[${i}] is not an object`);
      const price = finite(l, `market.availableEnergyByPrice[${i}]`, "price");
      const value = finite(l, `market.availableEnergyByPrice[${i}]`, "value");
      if (!(price > 0) || value < 0) throw new Error(`market.availableEnergyByPrice[${i}] has a non-positive price or negative value`);
      return { price, value };
    }).sort((x, y) => x.price - y.price);
    if (levels.length === 0) throw new Error("market.availableEnergyByPrice is empty");
    let depth = 0;
    let marginal = levels[0]!.price;
    for (const l of levels) {
      if (depth >= size) break;
      if (l.value === 0) continue;
      depth += l.value;
      marginal = l.price;
    }
    const perDay = Math.max(marginal, floor);
    return { raw: { kind: "sunPerUnit", value: temHourSunPerUnit(perDay), term: "1h" }, depth: Math.floor(depth) };
  },
};
