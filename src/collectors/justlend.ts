import { INSTRUMENT, SUN_PER_TRX } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const URL = "https://openapi.just.network/lend/strx";
/** JustLend prices rent in TRX per this many energy units per day. */
const PRICE_UNITS = 10_000;

interface Body {
  code?: number;
  message?: string;
  data?: { stakeInfo?: { rentReserveFactor?: unknown }; rentInfo?: { priceFor10KEnergByRent?: unknown } };
}

/** JustLend sends decimals as strings. Only a non-empty string or a number counts; null, "" and booleans would coerce to 0 or 1. */
function decimal(v: unknown, name: string): number {
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${name} missing or not a number`);
  return n;
}

function parseStrx(body: string): { grossSunPerUnitDay: number; reserveFactor: number } {
  const b = JSON.parse(body) as Body | null;
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error("body is not an object");
  if (b.code !== 0) throw new Error(`venue error: ${String(b.message ?? "")}`);
  const priceName = "data.rentInfo.priceFor10KEnergByRent";
  const reserveName = "data.stakeInfo.rentReserveFactor";
  const price = decimal(b.data?.rentInfo?.priceFor10KEnergByRent, priceName);
  if (price <= 0) throw new Error(`${priceName} is not positive`);
  const reserve = decimal(b.data?.stakeInfo?.rentReserveFactor, reserveName);
  if (reserve < 0 || reserve >= 1) throw new Error(`${reserveName} is outside [0, 1)`);
  return { grossSunPerUnitDay: (price * SUN_PER_TRX) / PRICE_UNITS, reserveFactor: reserve };
}

const request = (): { url: string; init: RequestInit } => ({ url: URL, init: { method: "GET", headers: { accept: "application/json" } } });

/** JustLend's posted daily rate. Rentals are three hours minimum, so this is the 1-day series, never the hourly print. */
export const justlend: VenueAdapter = {
  venue: "justlend",
  requests: [{ size: INSTRUMENT.units, term: "1d" }],
  request,
  parse(body): Parsed {
    const { grossSunPerUnitDay } = parseStrx(body);
    return { raw: { kind: "sunPerUnit", value: grossSunPerUnitDay, term: "1d" }, depth: null };
  },
};

/** The supplier's alternative: the daily rate net of what JustLend keeps (rentReserveFactor). verify-band reads this row. */
export const justlendNet: VenueAdapter = {
  venue: "justlend-net",
  requests: [{ size: INSTRUMENT.units, term: "1d" }],
  request,
  parse(body): Parsed {
    const { grossSunPerUnitDay, reserveFactor } = parseStrx(body);
    return { raw: { kind: "sunPerUnit", value: grossSunPerUnitDay * (1 - reserveFactor), term: "1d" }, depth: null };
  },
};
