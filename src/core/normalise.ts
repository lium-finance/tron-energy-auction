import { SUN_PER_TRX, TERM_HOURS, TRANSFER_UNITS, type Term } from "./types.js";

/**
 * `term` rule, one for every kind:
 * - `sunPerUnit` is already in the output unit (sun per unit for 1h, sun per unit per day for 1d/7d/14d). Never divided.
 * - `sunPerUnitOverTerm`, `trxPerTransfer` and `usdtPerTransfer` are a total for the whole term. For 1d/7d/14d they
 *   are divided by the number of days; for 1h the total for the hour IS the output unit, so the factor is 1.
 */
export type RawPrice =
  | { kind: "sunPerUnit"; value: number; term: Term }
  | { kind: "sunPerUnitOverTerm"; value: number; term: Term }
  | { kind: "trxPerTransfer"; value: number; term: Term }
  | { kind: "usdtPerTransfer"; value: number; term: Term; trxUsd: number };

export type Normalised = { ok: true; sunPerUnit: number } | { ok: false; reason: string };

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Turn a venue's price into the index's unit: sun per energy unit for the hourly instrument, sun per unit
 * per day for the term series. The ceiling is the hour's energy fee (a vote parameter, read each hour), not
 * a literal: nobody rents above the burn price, so anything above it is a unit error, not a price.
 */
export function normalise(raw: RawPrice, energyFeeSun: number): Normalised {
  if (!Number.isFinite(energyFeeSun) || energyFeeSun < 1) return { ok: false, reason: "no usable energy fee" };
  if (!Number.isFinite(raw.value)) return { ok: false, reason: "price is not a finite number" };
  const perTermFactor = raw.term === "1h" ? 1 : TERM_HOURS[raw.term] / 24;
  let perUnit: number;
  switch (raw.kind) {
    case "sunPerUnit":
      perUnit = raw.value;
      break;
    case "sunPerUnitOverTerm":
      perUnit = raw.value / perTermFactor;
      break;
    case "trxPerTransfer":
      perUnit = (raw.value * SUN_PER_TRX) / TRANSFER_UNITS / perTermFactor;
      break;
    case "usdtPerTransfer":
      if (!Number.isFinite(raw.trxUsd) || raw.trxUsd <= 0) return { ok: false, reason: "no TRX price for a USDT quote" };
      perUnit = ((raw.value / raw.trxUsd) * SUN_PER_TRX) / TRANSFER_UNITS / perTermFactor;
      break;
  }
  const rounded = round2(perUnit);
  if (!Number.isFinite(rounded)) return { ok: false, reason: "price is not a finite number" };
  const label = raw.term === "1h" ? "sun/unit" : "sun/unit-day";
  if (!(rounded >= 1)) return { ok: false, reason: `${rounded} ${label} is below 1 sun` };
  if (!(rounded <= energyFeeSun)) return { ok: false, reason: `${rounded} ${label} is above the energy fee of ${energyFeeSun} sun` };
  return { ok: true, sunPerUnit: rounded };
}
