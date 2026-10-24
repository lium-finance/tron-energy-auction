import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { netts } from "../../src/collectors/netts.js";

const ctx = (env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): CollectContext => ({
  hour: 1, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
  fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl },
  redact: (s) => s, env,
});
const neverCalled = (): typeof fetch => vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

describe("netts", () => {
  it("is missing without a key, with the reason, and is not asked", async () => {
    const f = neverCalled();
    const [q] = await collect(netts, ctx({}, f));
    expect(q).toMatchObject({ venue: "netts", size: 20_000_000, term: "1h", status: "missing", sunPerUnit: null, reason: "requires NETTS_API_KEY; one order is capped at 3,000,000 units" });
    expect(f).not.toHaveBeenCalled();
  });
  it("is still missing with a key, because no keyed answer has been recorded to parse", async () => {
    const f = neverCalled();
    const [q] = await collect(netts, ctx({ NETTS_API_KEY: "k" }, f));
    expect(q).toMatchObject({ status: "missing", reason: "no recorded keyed response to parse (2026-10-22); one order is capped at 3,000,000 units" });
    expect(f).not.toHaveBeenCalled();
  });
});
