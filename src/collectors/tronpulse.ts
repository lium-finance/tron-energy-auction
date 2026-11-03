import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const MARKET_SETTINGS = "https://tronpulse.io/api/energypool/market_settings";
/** 1 hour at 3 seconds per block. */
const HOUR_BLOCKS = 1_200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * TronPulse's keyless market settings (recorded 2026-10-28 in docs/verification/venue-apis-2026-10-28.md; fixture
 * test/fixtures/tronpulse-market-settings.json). `data.energy_duration[]` lists each rental term's minimum price;
 * the 1-hour row (`unit` "hour", `value` 1, `block_duration` 1200) is in sun per unit for the whole rental (the site's
 * energypool.min.js charges amount × price for hour terms, read 2026-10-28). It is a minimum buy price, not a fill:
 * the size quote (`POST /api/exchange/get_quote`) needs an Api-Key, and the keyless book and liquidity endpoints
 * (`/api/energypool/order/market_orders`, `/api/energypool/pool/liquidity`) answered 503 on 2026-10-28, so there is
 * no recorded success body to parse depth from. The row is the 1h minimum as `depth-unknown`.
 */
export const tronpulse: VenueAdapter = {
  venue: "tronpulse",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  request() {
    return { url: MARKET_SETTINGS, init: { method: "GET", headers: { accept: "application/json", "user-agent": "Mozilla/5.0 tron-energy-index" } } };
  },
  parse(body): Parsed {
    const b = JSON.parse(body) as unknown;
    if (!isObj(b)) throw new Error("body is not an object");
    if (b.success !== true) throw new Error(`success is ${JSON.stringify(b.success)}`);
    if (!isObj(b.data)) throw new Error("data missing or not an object");
    const durations = b.data.energy_duration;
    if (!Array.isArray(durations)) throw new Error("data.energy_duration missing or not an array");
    const hour = (durations as unknown[]).filter(
      (d): d is Record<string, unknown> => isObj(d) && d.unit === "hour" && d.value === 1,
    );
    if (hour.length !== 1) throw new Error(`expected one 1-hour energy_duration row, found ${hour.length}`);
    const row = hour[0]!;
    if ("block_duration" in row && row.block_duration !== HOUR_BLOCKS) throw new Error(`1-hour row block_duration is ${JSON.stringify(row.block_duration)}, not ${HOUR_BLOCKS}`);
    const price = row.energy_min_price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("1-hour energy_min_price missing or not a positive number");
    return {
      raw: { kind: "sunPerUnit", value: price, term: "1h" },
      depth: null,
      note: "minimum 1-hour buy price; no depth or 20M quote without a key",
    };
  },
};
