import { describe, expect, it } from "vitest";
import { normalise } from "../../src/core/normalise.js";

const fee = 210; // the energy fee in sun, as the chain reader reports it

describe("normalise", () => {
  it("accepts sun per unit inside the band for the hourly instrument", () => {
    expect(normalise({ kind: "sunPerUnit", value: 150, term: "1h" }, fee)).toEqual({ ok: true, sunPerUnit: 150 });
  });
  it("rejects a quote above the hour's fee and below 1 sun", () => {
    expect(normalise({ kind: "sunPerUnit", value: 250, term: "1h" }, fee)).toEqual({ ok: false, reason: "250 sun/unit is above the energy fee of 210 sun" });
    expect(normalise({ kind: "sunPerUnit", value: 0.5, term: "1h" }, fee)).toEqual({ ok: false, reason: "0.5 sun/unit is below 1 sun" });
  });
  it("stores a term quote per unit-day and bounds it per day", () => {
    // 310 sun per unit over 7 days is 44.3 per unit-day: accepted; the same 310 for one hour is rejected.
    expect(normalise({ kind: "sunPerUnitOverTerm", value: 310, term: "7d" }, fee)).toEqual({ ok: true, sunPerUnit: 44.29 });
    expect(normalise({ kind: "sunPerUnit", value: 310, term: "1h" }, fee).ok).toBe(false);
  });
  it("converts TRX per transfer at 65,000 units a transfer", () => {
    // 1.95 TRX for 65,000 units for an hour = 30 sun per unit (GetBlock's page tier).
    expect(normalise({ kind: "trxPerTransfer", value: 1.95, term: "1h" }, fee)).toEqual({ ok: true, sunPerUnit: 30 });
  });
  it("converts USDT per transfer at the TRX price read in the same minute", () => {
    // 1 USDT at $0.33 a TRX is 3.0303 TRX for 65,000 units = 46.62 sun per unit.
    expect(normalise({ kind: "usdtPerTransfer", value: 1, term: "1h", trxUsd: 0.33 }, fee)).toEqual({ ok: true, sunPerUnit: 46.62 });
  });
  it("rejects a value that is not a finite number", () => {
    expect(normalise({ kind: "sunPerUnit", value: Number.NaN, term: "1h" }, fee)).toEqual({ ok: false, reason: "price is not a finite number" });
  });
  it("rejects when the energy fee is not usable", () => {
    expect(normalise({ kind: "sunPerUnit", value: 100, term: "1h" }, Number.NaN)).toEqual({ ok: false, reason: "no usable energy fee" });
    expect(normalise({ kind: "sunPerUnit", value: 100, term: "1h" }, 0)).toEqual({ ok: false, reason: "no usable energy fee" });
  });
  it("treats a total for a one-hour term as already per unit", () => {
    expect(normalise({ kind: "sunPerUnitOverTerm", value: 40, term: "1h" }, fee)).toEqual({ ok: true, sunPerUnit: 40 });
  });
  it("divides per-transfer totals by the days in the term", () => {
    expect(normalise({ kind: "trxPerTransfer", value: 1.95, term: "1d" }, fee)).toEqual({ ok: true, sunPerUnit: 30 });
    expect(normalise({ kind: "trxPerTransfer", value: 1.95, term: "7d" }, fee)).toEqual({ ok: true, sunPerUnit: 4.29 });
  });
  it("never divides a price already quoted per unit-day", () => {
    expect(normalise({ kind: "sunPerUnit", value: 44, term: "7d" }, fee)).toEqual({ ok: true, sunPerUnit: 44 });
  });
  it("rejects a USDT quote with no usable TRX price", () => {
    expect(normalise({ kind: "usdtPerTransfer", value: 1, term: "1h", trxUsd: 0 }, fee)).toEqual({ ok: false, reason: "no TRX price for a USDT quote" });
  });
  it("accepts exactly 1 sun and exactly the fee, rejects just above", () => {
    expect(normalise({ kind: "sunPerUnit", value: 1, term: "1h" }, fee)).toEqual({ ok: true, sunPerUnit: 1 });
    expect(normalise({ kind: "sunPerUnit", value: 210, term: "1h" }, fee)).toEqual({ ok: true, sunPerUnit: 210 });
    expect(normalise({ kind: "sunPerUnit", value: 210.01, term: "1h" }, fee)).toEqual({ ok: false, reason: "210.01 sun/unit is above the energy fee of 210 sun" });
  });
});
