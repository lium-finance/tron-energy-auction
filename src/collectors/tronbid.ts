import { INSTRUMENT, SUN_PER_TRX } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const CATALOG = "https://tronbid.com/api/public/quick-rent/skus?resource_type=energy";
/** The package term the hourly row reads, in minutes. */
const HOUR_MINUTES = 60;

/** A catalog field as a positive finite number; the catalog sends `energy_amount` and `price_trx` as strings. */
function positiveField(sku: Record<string, unknown>, i: number, name: string): number {
  const v = sku[name];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`skus[${i}].${name} missing or not a positive number`);
  return n;
}

const isHourRow = (sku: Record<string, unknown>): boolean => {
  const d = sku.duration_minutes;
  return (typeof d === "number" || typeof d === "string") && Number(d) === HOUR_MINUTES;
};

/**
 * TronBid has no keyless API that prices a given size or reports depth (recorded 2026-10-22 in
 * docs/verification/venue-apis.md): `POST /api/v2/quick-rent/availability` and `POST /api/v2/quick-rent/quote`
 * need a Bearer key. The one keyless endpoint is the package catalog (fixture test/fixtures/tronbid-skus-energy.json):
 * fixed Energy packages up to 1,048,000 units for 15 or 60 minutes, with `price_trx` and no depth. The row reads
 * the largest 60-minute package as sun per unit for 1h, depth unknown, published beside the print like GetBlock's.
 */
export const tronbid: VenueAdapter = {
  venue: "tronbid",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  request() {
    return { url: CATALOG, init: { method: "GET", headers: { accept: "application/json", "user-agent": "Mozilla/5.0 tron-energy-index" } } };
  },
  parse(body): Parsed {
    const b = JSON.parse(body) as { skus?: unknown };
    if (!Array.isArray(b.skus)) throw new Error("skus missing or not an array");
    let best: { units: number; trx: number } | null = null;
    for (const [i, s] of (b.skus as unknown[]).entries()) {
      if (typeof s !== "object" || s === null) continue;
      const sku = s as Record<string, unknown>;
      // A row for another resource means this is not the energy catalog: fail, whatever its duration.
      if ("resource_type" in sku && sku.resource_type !== "energy") throw new Error(`skus[${i}].resource_type is ${JSON.stringify(sku.resource_type)}, not "energy"`);
      // Only 60-minute rows are validated and can be selected; a malformed 15-minute (or other) row is ignored.
      if (!isHourRow(sku)) continue;
      const units = positiveField(sku, i, "energy_amount");
      const trx = positiveField(sku, i, "price_trx");
      if (best === null || units > best.units) best = { units, trx };
    }
    if (best === null) throw new Error("no 60-minute energy package in the catalog");
    return {
      raw: { kind: "sunPerUnit", value: (best.trx * SUN_PER_TRX) / best.units, term: "1h" },
      depth: null,
      note: `price of the ${best.units.toLocaleString("en-US")}-unit 60-minute package; no depth or 20M quote available`,
    };
  },
};
