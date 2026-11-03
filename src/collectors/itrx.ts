import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const INDEX_DATA = "https://itrx.io/api/v1/frontend/index-data";
/** `tiered_pricing[].period` for one hour (develop.itrx.io/api/index-data.html, read 2026-10-28: 0 = 1 hour, 1 = 1 day, 3 = 3 days, 30 = 30 days). */
const PERIOD_1H = 0;

export const ITRX_PUBLISH_GATE = "PUBLISH_ITRX";
export const ITRX_NOTE_TOS = "iTRX terms restrict reproducing its data";

/** A field as a finite number, or throw naming it. */
function num(b: Record<string, unknown>, name: string): number {
  const v = b[name];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} missing or not a number`);
  return v;
}

/**
 * iTRX's keyless catalog (recorded 2026-10-28 in docs/verification/venue-apis-2026-10-28.md; fixture test/fixtures/itrx-index-data.json):
 * `tiered_pricing[period 0].price` and `g1h` are the 1-hour price in sun per unit, and `platform_avail_energy` is the
 * energy the platform can delegate now, which is the depth. One GET carries both. The size quote
 * (`/api/v1/frontend/order/price?period=1H&energy_amount=...`) answered the same 35 sun for 20M and for 250M, above the
 * documented maximum and the available energy, so it enforces no size and adds nothing this read does not have.
 * Depth is also capped by `maximum_order_energy`. At the recorded sample 12,387,503 units were available, so the row is
 * `no-depth` for 20M.
 *
 * Collect-only: iTRX's terms (itrx.io/terms, read 2026-10-28) say its data may not be reproduced on another service,
 * so the rows are stored and never counted or published until PUBLISH_ITRX=on (src/index/gate.ts).
 */
export const itrx: VenueAdapter = {
  venue: "itrx",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  publishGate: ITRX_PUBLISH_GATE,
  request() {
    // No API-KEY header: the catalog is public without one, and a wrong key turns the answer into {"detail":"API not found"}.
    return { url: INDEX_DATA, init: { method: "GET", headers: { accept: "application/json", "user-agent": "Mozilla/5.0 tron-energy-index" } } };
  },
  parse(body): Parsed {
    const b = JSON.parse(body) as unknown;
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error("body is not an object");
    const o = b as Record<string, unknown>;
    if (typeof o.detail === "string") throw new Error(`venue error: ${o.detail}`);
    const tiers = o.tiered_pricing;
    if (!Array.isArray(tiers)) throw new Error("tiered_pricing missing or not an array");
    const hour = (tiers as unknown[]).filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && (t as Record<string, unknown>).period === PERIOD_1H);
    if (hour.length !== 1) throw new Error(`expected one tiered_pricing row for period ${PERIOD_1H}, found ${hour.length}`);
    const price = num(hour[0]!, "price");
    if (!(price > 0)) throw new Error("tiered_pricing period 0 price is not positive");
    // g1h is the same 1-hour price; when both are sent and disagree, neither can be trusted as the one sold.
    if ("g1h" in o && num(o, "g1h") !== price) throw new Error(`g1h ${String(o.g1h)} does not match tiered_pricing period 0 price ${price}`);
    const avail = num(o, "platform_avail_energy");
    if (avail < 0) throw new Error("platform_avail_energy is negative");
    const maxOrder = num(o, "maximum_order_energy");
    if (!(maxOrder > 0)) throw new Error("maximum_order_energy is not positive");
    return { raw: { kind: "sunPerUnit", value: price, term: "1h" }, depth: Math.min(avail, maxOrder) };
  },
};
