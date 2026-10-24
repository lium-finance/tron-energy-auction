import { describe, expect, it } from "vitest";
import { hourOf, hourStart, msUntilMinute } from "../../src/core/hour.js";

describe("hourOf", () => {
  it("buckets 00:59:58 into hour 00 and 01:00:00 into hour 01", () => {
    const h0 = hourOf(new Date("2026-10-28T00:59:58Z"));
    const h1 = hourOf(new Date("2026-10-28T01:00:00Z"));
    expect(h1).toBe(h0 + 1);
    expect(hourStart(h0).toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });
});

describe("msUntilMinute", () => {
  it("counts to the next :00 and :05 after the given time", () => {
    const from = new Date("2026-10-28T13:42:10Z");
    expect(msUntilMinute(0, from)).toBe((17 * 60 + 50) * 1000);
    expect(msUntilMinute(5, from)).toBe((22 * 60 + 50) * 1000);
  });
  it("goes a full hour when called exactly on the minute", () => {
    expect(msUntilMinute(0, new Date("2026-10-28T14:00:00Z"))).toBe(3_600_000);
  });
  it("handles boundaries within the hour and across a year end", () => {
    expect(msUntilMinute(5, new Date("2026-10-28T13:50:00Z"))).toBe(900_000);
    expect(msUntilMinute(0, new Date("2026-12-31T23:58:00Z"))).toBe(120_000);
    expect(msUntilMinute(5, new Date("2026-12-31T23:58:00Z"))).toBe(420_000);
    expect(msUntilMinute(5, new Date("2026-10-28T14:05:00Z"))).toBe(3_600_000);
  });
  it("rejects a minute outside 0 to 59 or not an integer", () => {
    const from = new Date("2026-10-28T13:42:10Z");
    for (const bad of [-1, 60, 1.5, Number.NaN, Infinity]) {
      expect(() => msUntilMinute(bad, from)).toThrow(new RangeError("minute must be an integer from 0 to 59"));
    }
  });
  it("rejects an invalid date", () => {
    expect(() => msUntilMinute(0, new Date("nonsense"))).toThrow(new RangeError("from is not a valid date"));
  });
});
