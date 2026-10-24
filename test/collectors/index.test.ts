import { describe, expect, it } from "vitest";
import { VENUES } from "../../src/collectors/index.js";

describe("VENUES", () => {
  it("lists every venue once, in the order the hour job asks them", () => {
    expect(VENUES.map((v) => v.venue)).toEqual(["tronsave", "tronbid", "getblock", "netts", "justlend", "justlend-net"]);
  });
});
