import { describe, expect, it } from "vitest";
import type { VenueAdapter } from "../../src/collectors/adapter.js";
import { collectOnlyVenues, ConfigError } from "../../src/index/config.js";
import { allGatedVenues, publishable } from "../../src/index/gate.js";

const v = (venue: string, publishGate?: string): VenueAdapter => ({
  venue, requests: [], request: () => null, parse: () => ({ raw: null, depth: 0 }), ...(publishGate ? { publishGate } : {}),
});
const venues = [v("open"), v("x", "PUBLISH_X"), v("y", "PUBLISH_Y")];

describe("collectOnlyVenues", () => {
  it("keeps every gated venue collect-only when its variable is unset, blank or off", () => {
    expect(collectOnlyVenues({}, venues)).toEqual(new Set(["x", "y"]));
    expect(collectOnlyVenues({ PUBLISH_X: " ", PUBLISH_Y: "off" }, venues)).toEqual(new Set(["x", "y"]));
  });
  it("opens only the venues whose variable is on, and never lists an ungated venue", () => {
    expect(collectOnlyVenues({ PUBLISH_X: "on" }, venues)).toEqual(new Set(["y"]));
    expect(collectOnlyVenues({ PUBLISH_X: " on ", PUBLISH_Y: "on" }, venues)).toEqual(new Set());
  });
  it("rejects any other value, naming the variable", () => {
    for (const bad of ["true", "1", "ON", "yes"]) {
      expect(() => collectOnlyVenues({ PUBLISH_Y: bad }, venues)).toThrow(new ConfigError("PUBLISH_Y must be on or off"));
    }
  });
  it("gates iTRX, TRON Energy Market and TokenGoodies by default, and nothing else", () => {
    expect(collectOnlyVenues({})).toEqual(new Set(["itrx", "tronenergy-market", "tronzap", "tokengoodies"]));
    expect(allGatedVenues()).toEqual(new Set(["itrx", "tronenergy-market", "tronzap", "tokengoodies"]));
  });
});

describe("publishable", () => {
  it("drops the collect-only venues' quotes and keeps the rest in order", () => {
    const quotes = [{ venue: "a" }, { venue: "x" }, { venue: "b" }, { venue: "x" }];
    expect(publishable(quotes, new Set(["x"]))).toEqual([{ venue: "a" }, { venue: "b" }]);
    expect(publishable(quotes, new Set())).toEqual(quotes);
  });
});
