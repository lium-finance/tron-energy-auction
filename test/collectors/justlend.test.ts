import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { justlend, justlendNet } from "../../src/collectors/justlend.js";

const fixture = readFileSync(new URL("../fixtures/justlend-strx.json", import.meta.url), "utf8");
const ctx = (body: string): CollectContext => ({
  hour: 1, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
  fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch },
  redact: (s) => s, env: {},
});

/** The fixture with one value replaced, to drive the schema checks. */
function withFields(price: unknown, reserve: unknown): string {
  const b = JSON.parse(fixture) as { data: { stakeInfo: { rentReserveFactor: unknown }; rentInfo: { priceFor10KEnergByRent: unknown } } };
  b.data.rentInfo.priceFor10KEnergByRent = price;
  b.data.stakeInfo.rentReserveFactor = reserve;
  return JSON.stringify(b);
}

describe("justlend", () => {
  it("publishes the gross daily rate as the 1-day series, depth unknown", async () => {
    const [q] = await collect(justlend, ctx(fixture));
    expect(q).toMatchObject({ venue: "justlend", term: "1d", size: 20_000_000, sunPerUnit: 45.26, depth: null, status: "depth-unknown" });
  });
  it("publishes the net daily rate (gross × (1 − reserve factor)) as justlend-net", async () => {
    const [q] = await collect(justlendNet, ctx(fixture));
    expect(q).toMatchObject({ venue: "justlend-net", term: "1d", sunPerUnit: 36.21, status: "depth-unknown" });
  });
  it("fails on a non-zero code", async () => {
    const [q] = await collect(justlend, ctx('{"code":1,"message":"busy"}'));
    expect(q).toMatchObject({ status: "failed", reason: "schema: venue error: busy" });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-0.45"],
    ["empty string", ""],
    ["null", null],
    ["not a number", "abc"],
    ["infinite", "Infinity"],
  ])("rejects a %s price as a schema error on both series", async (_name, price) => {
    for (const a of [justlend, justlendNet]) {
      const [q] = await collect(a, ctx(withFields(price, "0.2")));
      expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
      expect(q?.reason).toMatch(/^schema: data\.rentInfo\.priceFor10KEnergByRent /);
    }
  });

  it.each([
    ["one", "1"],
    ["above one", "1.5"],
    ["negative", "-0.1"],
    ["empty string", ""],
    ["null", null],
    ["missing", undefined],
  ])("rejects a reserve factor that is %s as a schema error on both series", async (_name, reserve) => {
    for (const a of [justlend, justlendNet]) {
      const [q] = await collect(a, ctx(withFields("0.45262057", reserve)));
      expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
      expect(q?.reason).toMatch(/^schema: data\.stakeInfo\.rentReserveFactor /);
    }
  });

  it("accepts a reserve factor of zero: net equals gross", async () => {
    const [q] = await collect(justlendNet, ctx(withFields("0.45262057", "0")));
    expect(q).toMatchObject({ sunPerUnit: 45.26, status: "depth-unknown" });
  });

  it("rejects a gross rate above the energy fee through normalise, not as a schema error", async () => {
    const [q] = await collect(justlend, ctx(withFields("1029.9", "0.2")));
    expect(q).toMatchObject({ status: "rejected", sunPerUnit: null });
  });
});
