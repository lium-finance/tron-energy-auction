import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

/** One 1-hour order is capped at 3,000,000 units (doc.netts.io, order1h, read 2026-10-22), so NetTS never fills the 20,000,000-unit instrument. */
export const NETTS_NO_KEY = "requires NETTS_API_KEY; one order is capped at 3,000,000 units";
export const NETTS_NO_PARSER = "no recorded keyed response to parse (2026-10-22); one order is capped at 3,000,000 units";

/**
 * NetTS answers every keyless call with 401 (recorded 2026-10-22 in docs/verification/venue-apis.md); its
 * price endpoints need `X-API-KEY` and a whitelisted `X-Real-IP`. No keyed answer has been recorded, so no
 * parser is written: every row is `missing` with the reason, key or no key, and the venue is never asked.
 * When a keyed answer is recorded as a fixture, `request` and `parse` are written against it.
 */
export const netts: VenueAdapter = {
  venue: "netts",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  request(_size, _term, ctx) {
    return { skip: ctx.env.NETTS_API_KEY ? NETTS_NO_PARSER : NETTS_NO_KEY };
  },
  parse(): Parsed {
    throw new Error("netts is never asked; see docs/verification/venue-apis.md");
  },
};
