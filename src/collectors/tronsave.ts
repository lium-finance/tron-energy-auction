import { INSTRUMENT, LADDER_UNITS, TERM_HOURS, type Term } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";
import type { RawPrice } from "../core/normalise.js";

const URL = "https://api.tronsave.io/v2/estimate-buy-resource";

/** The rental duration TronSave is asked for, and echoes back, in seconds. */
const durationSec = (term: Term): number => TERM_HOURS[term] * 3600;

interface Body {
  error?: boolean;
  message?: string;
  data?: { unitPrice?: unknown; availableResource?: unknown; durationSec?: unknown };
}

/**
 * Measured 2026-10-20: `unitPrice` is sun per unit for the whole duration up to one day (1h, 1d), and sun per
 * unit per day beyond one day (7d, 14d). Under the normalise rule the 1h and 7d/14d prices are already in the
 * output unit (`sunPerUnit`); the 1d price is a total for a one-day term (`sunPerUnitOverTerm`, divided by 1 day).
 */
function rawPrice(value: number, term: Term): RawPrice {
  if (term === "1d") return { kind: "sunPerUnitOverTerm", value, term };
  return { kind: "sunPerUnit", value, term };
}

export const tronsave: VenueAdapter = {
  venue: "tronsave",
  requests: [
    ...LADDER_UNITS.map((size) => ({ size, term: "1h" as Term })),
    { size: INSTRUMENT.units, term: "1d" }, { size: INSTRUMENT.units, term: "7d" }, { size: INSTRUMENT.units, term: "14d" },
  ],
  request(size, term) {
    return {
      url: URL,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceAmount: size, resourceType: "ENERGY", durationSec: durationSec(term), unitPrice: "MEDIUM" }),
      },
    };
  },
  parse(body, _size, term): Parsed {
    const b = JSON.parse(body) as Body;
    if (b.error === true) throw new Error(`venue error: ${String(b.message ?? "")}`);
    const price = b.data?.unitPrice;
    const avail = b.data?.availableResource;
    if (typeof price !== "number") throw new Error("data.unitPrice missing or not a number");
    if (typeof avail !== "number" || !Number.isFinite(avail) || avail < 0) throw new Error("data.availableResource missing, negative or not a number");
    const duration = b.data?.durationSec;
    const wanted = durationSec(term);
    if (typeof duration === "number" && duration !== wanted) throw new Error(`durationSec ${duration} does not match the requested ${wanted}`);
    return { raw: rawPrice(price, term), depth: avail };
  },
};
