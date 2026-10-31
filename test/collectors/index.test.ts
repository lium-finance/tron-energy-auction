import { describe, expect, it } from "vitest";
import { VENUES } from "../../src/collectors/index.js";

describe("VENUES", () => {
  it("lists every venue once, in the order the hour job asks them", () => {
    expect(VENUES.map((v) => v.venue)).toEqual(["tronsave", "tronbid", "getblock", "netts", "justlend", "justlend-net", "itrx", "tronenergy-market", "tronzap", "tronpulse", "tokengoodies"]);
  });
  it("gates exactly the venues whose terms restrict reproducing their data", () => {
    expect(VENUES.filter((v) => v.publishGate).map((v) => [v.venue, v.publishGate])).toEqual([
      ["itrx", "PUBLISH_ITRX"], ["tronenergy-market", "PUBLISH_TRONENERGY_MARKET"], ["tronzap", "PUBLISH_TRONZAP"], ["tokengoodies", "PUBLISH_TOKENGOODIES"],
    ]);
  });
});
