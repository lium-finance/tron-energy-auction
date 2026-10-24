import { describe, expect, it } from "vitest";
import type { Quote, QuoteStatus } from "../../src/core/types.js";
import { quoteLine, smokeExitCode, smokeSummary, statusCounts } from "../../src/scripts/report.js";

function q(status: QuoteStatus, over: Partial<Quote> = {}): Quote {
  return { hour: 1, venue: "tronsave", size: 20_000_000, term: "1h", sunPerUnit: status === "ok" ? 60 : null, depth: status === "ok" ? 20_000_000 : null, readAt: new Date(0), source: "s", status, reason: status === "ok" ? null : "why", payloadHash: null, ...over };
}

describe("quoteLine", () => {
  it("lays out venue, size, term, status, price, depth and reason", () => {
    expect(quoteLine(q("ok"))).toBe("tronsave       20000000 1h  ok            60 depth=20000000");
    expect(quoteLine(q("failed", { venue: "getblock" }))).toBe("getblock       20000000 1h  failed        — depth=? (why)");
  });
});

describe("statusCounts and smokeSummary", () => {
  const quotes = [q("ok"), q("ok"), q("failed"), q("missing"), q("depth-unknown")];
  it("counts per status in a fixed order and leaves out zeros", () => {
    expect(statusCounts(quotes)).toEqual([{ status: "ok", count: 2 }, { status: "depth-unknown", count: 1 }, { status: "failed", count: 1 }, { status: "missing", count: 1 }]);
  });
  it("names the counts and whether the chain and CoinGecko worked", () => {
    expect(smokeSummary(quotes, true, false)).toBe("summary: 5 quotes (ok=2 depth-unknown=1 failed=1 missing=1); chain ok; coingecko FAILED");
    expect(smokeSummary([], false, true)).toBe("summary: 0 quotes (no quotes); chain FAILED; coingecko ok");
  });
});

describe("smokeExitCode", () => {
  it("is 0 when venues fail but the chain read worked", () => {
    expect(smokeExitCode([q("failed"), q("failed")], true)).toBe(0);
  });
  it("is 0 when the chain read failed but a venue answered", () => {
    for (const s of ["ok", "no-depth", "depth-unknown", "rejected"] as const) expect(smokeExitCode([q("failed"), q(s)], false), s).toBe(0);
  });
  it("is 1 when the chain read failed and every venue failed or was skipped, or there were no quotes", () => {
    expect(smokeExitCode([q("failed"), q("missing")], false)).toBe(1);
    expect(smokeExitCode([], false)).toBe(1);
  });
});
