import { describe, expect, it } from "vitest";
import { hourOf } from "../../src/core/hour.js";
import { parseHourArg } from "../../src/scripts/hour-arg.js";

const now = new Date("2026-10-22T10:30:00Z");
const current = hourOf(now);

describe("parseHourArg", () => {
  it("defaults to the current hour", () => {
    expect(parseHourArg(undefined, now)).toBe(current);
  });
  it("accepts an argument equal to the current hour", () => {
    expect(parseHourArg(String(current), now)).toBe(current);
  });
  it("rejects every other hour, past or future, as a ConfigError naming the current hour", () => {
    for (const h of [current - 1, current + 1, current - 48, current + 48, 999_999_999, 0]) {
      expect(() => parseHourArg(String(h), now), String(h)).toThrow(
        expect.objectContaining({ name: "ConfigError", message: expect.stringContaining(`collect-once only collects the current hour (${current}); quotes are read now and stamped with the hour`) }),
      );
    }
  });
  it("rejects anything that is not a plain non-negative integer", () => {
    for (const bad of ["", " ", "abc", "-1", "1.5", "1e3", "0x10", `${current} `, `0${current}x`, "+5", "NaN", "Infinity", "9".repeat(400)]) {
      expect(() => parseHourArg(bad, now), bad).toThrow(expect.objectContaining({ name: "ConfigError" }));
    }
  });
  it("does not echo a long argument in full", () => {
    expect(() => parseHourArg("x".repeat(500), now)).toThrow(/^.{0,220}$/);
  });
});
