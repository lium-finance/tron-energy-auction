import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const RATES = "https://tronzap.com/api/rates";

export const TRONZAP_PUBLISH_GATE = "PUBLISH_TRONZAP";

function positive(o: Record<string, unknown>, name: string): number {
  const v = o[name];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${name} missing or not a positive number`);
  return v;
}

/**
 * TronZap's keyless website rates (recorded 2026-10-28 in docs/verification/venue-apis-2026-10-28.md; fixture
 * test/fixtures/tronzap-rates.json): `price_65k` is the TRX price of one 65,000-unit transfer's energy for the site's
 * one rental term, 1 hour ("Energy arrives within a minute and lasts 1 hour", tronzap.com, read 2026-10-28; the API
 * docs say only 1 hour is supported). The size quote (`POST api.tronzap.com/v1/calculate`) needs a Bearer key and an
 * HMAC signature, and nothing keyless reports depth, so the row is the 65k headline price as `depth-unknown`.
 *
 * Collect-only: TronZap's terms (tronzap.com/terms, last updated 02.03.2025) say "You may not copy, reproduce, or
 * distribute any content without prior permission", so the rows are stored and never counted or published until
 * PUBLISH_TRONZAP=on (src/index/gate.ts).
 */
export const tronzap: VenueAdapter = {
  venue: "tronzap",
  publishGate: TRONZAP_PUBLISH_GATE,
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  request() {
    return { url: RATES, init: { method: "GET", headers: { accept: "application/json", "user-agent": "Mozilla/5.0 tron-energy-index" } } };
  },
  parse(body): Parsed {
    const b = JSON.parse(body) as unknown;
    if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error("body is not an object");
    const o = b as Record<string, unknown>;
    const p65 = positive(o, "price_65k");
    // The two-transfer price must be at least the one-transfer price; otherwise the fields no longer mean what they did.
    const p131 = positive(o, "price_131k");
    if (p131 < p65) throw new Error(`price_131k ${p131} is below price_65k ${p65}`);
    return {
      raw: { kind: "trxPerTransfer", value: p65, term: "1h" },
      depth: null,
      note: "price of one 65,000-unit transfer for 1 hour; no depth or 20M quote without a key",
    };
  },
};
