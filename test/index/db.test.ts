import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { print as makePrint } from "../../src/core/print.js";
import { METHOD_VERSION, type ChainParams, type Print, type Quote, type ResourceRead } from "../../src/core/types.js";
import { allPrints, chainForHour, createDb, hasPrint, insertChain, insertPrint, insertQuotes, insertPayloads, insertVerification, lastEnergyFeeRow, lastPrint, PAYLOAD_RETENTION_DAYS, prunePayloads, quotesForHour, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { testDbUrl as url } from "./testdb.js";

let sql: Sql;

beforeAll(async () => {
  if (!url) return;
  await runMigrations(url);
  sql = createDb(url);
  await sql`truncate quotes, prints, chain, verification, payloads, alerts`;
});
afterAll(async () => { await sql?.end(); });

const print = (hour: number): Print => ({ hour, median: 40, cheapest: 30, dearest: 50, liveCount: 3, depthAwareCount: 3, status: "live", methodVersion: METHOD_VERSION, printedAt: new Date() });
const quote = (hour: number, venue: string): Quote => ({ hour, venue, size: 20_000_000, term: "1h", sunPerUnit: 40, depth: 20_000_000, readAt: new Date(), source: "t", status: "ok", reason: null, payloadHash: null });

describe.skipIf(!url)("db", () => {
  it("migrates idempotently", async () => {
    expect(await runMigrations(url!)).toEqual([]);
  });
  it("inserts one print per hour and reports the second attempt as a no-op", async () => {
    expect(await insertPrint(sql, print(1))).toBe(true);
    expect(await insertPrint(sql, print(1))).toBe(false);
    expect(await hasPrint(sql, 1)).toBe(true);
    expect((await allPrints(sql)).map((p) => p.hour)).toEqual([1]);
  });
  it("keeps one quote row per (hour, venue, size, term)", async () => {
    await insertQuotes(sql, [quote(1, "a"), quote(1, "a"), quote(1, "b")]);
    expect((await quotesForHour(sql, 1)).map((q) => q.venue)).toEqual(["a", "b"]);
  });
  it("reads a print back exactly as it was inserted", async () => {
    const now = new Date("2026-10-28T14:00:30.123Z");
    const quotes = [30.11, 30.12, 41.3, 41.4].map((p, i) => ({ ...quote(7, `v${i}`), sunPerUnit: p, readAt: new Date("2026-10-28T14:00:12Z") }));
    const printed = makePrint(quotes, { now, hour: 7 });
    expect(printed.median).toBe(35.71); // (30.12 + 41.3) / 2, rounded to the stored four decimals
    await insertPrint(sql, printed);
    expect(await lastPrint(sql)).toEqual(printed);
    const thin: Print = { hour: 8, median: null, cheapest: null, dearest: null, liveCount: 0, depthAwareCount: 1, status: "no_index", methodVersion: METHOD_VERSION, printedAt: now };
    await insertPrint(sql, thin);
    expect(await lastPrint(sql)).toEqual(thin);
  });
  it("keeps the first quote row when the same key is inserted again, in one batch or later", async () => {
    await insertQuotes(sql, [{ ...quote(5, "a"), sunPerUnit: 40 }, { ...quote(5, "a"), sunPerUnit: 99 }]);
    await insertQuotes(sql, [{ ...quote(5, "a"), sunPerUnit: 77 }]);
    const rows = await quotesForHour(sql, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sunPerUnit).toBe(40);
  });
  it("reads every quote field back, nulls included", async () => {
    const readAt = new Date("2026-10-28T14:00:12.500Z");
    const full: Quote = { hour: 6, venue: "full", size: 5_000_000, term: "1d", sunPerUnit: 12.3457, depth: 3_000_000, readAt, source: "https://x.test/y", status: "ok", reason: null, payloadHash: "abc" };
    const empty: Quote = { hour: 6, venue: "gone", size: 20_000_000, term: "1h", sunPerUnit: null, depth: null, readAt, source: "m", status: "failed", reason: "timeout", payloadHash: null };
    await insertQuotes(sql, [full, empty]);
    expect(await quotesForHour(sql, 6)).toEqual([full, empty]);
  });
  it("reads chain params back, with and without a TRX price, and reports the latest energy fee", async () => {
    const readAt = new Date("2026-10-28T14:00:05Z");
    const withPrice: ChainParams = { hour: 10, energyFeeSun: 100, totalEnergyWeightTrx: 40_000_000_000, totalEnergyLimit: 180_000_000_000, trxUsd: 0.123456, readAt };
    const noPrice: ChainParams = { hour: 11, energyFeeSun: 120, totalEnergyWeightTrx: 40_000_000_001, totalEnergyLimit: 180_000_000_000, trxUsd: null, readAt };
    await insertChain(sql, withPrice);
    expect(await chainForHour(sql, 10)).toEqual(withPrice);
    expect((await lastEnergyFeeRow(sql, 10))?.fee).toBe(100);
    await insertChain(sql, noPrice);
    await insertChain(sql, { ...noPrice, energyFeeSun: 999 });
    expect(await chainForHour(sql, 11)).toEqual(noPrice);
    expect((await lastEnergyFeeRow(sql, 11))?.fee).toBe(120);
    expect(await lastEnergyFeeRow(sql, 12)).toEqual({ fee: 120, hour: 11 });
    // A row for a later hour is never the fallback for an earlier one.
    expect(await lastEnergyFeeRow(sql, 10)).toEqual({ fee: 100, hour: 10 });
    expect(await lastEnergyFeeRow(sql, 9)).toBeNull();
    expect(await chainForHour(sql, 12)).toBeNull();
  });
  it("stores one verification row per hour and wallet", async () => {
    const r: ResourceRead = { hour: 20, wallet: "TWallet", energyLimit: 1_000_000, energyUsed: 250_000, readAt: new Date("2026-10-28T14:00:00Z"), source: "trongrid" };
    await insertVerification(sql, r);
    await insertVerification(sql, { ...r, energyUsed: 999 });
    const rows = await sql<{ energy_limit: string; energy_used: string; source: string }[]>`select energy_limit, energy_used, source from verification where hour = 20 and wallet = 'TWallet'`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.energy_limit)).toBe(1_000_000);
    expect(Number(rows[0]?.energy_used)).toBe(250_000);
    expect(rows[0]?.source).toBe("trongrid");
  });
});

describe.skipIf(!url)("payloads", () => {
  const DAY = 86_400_000;
  it("stores one row per hash, whatever the number of quotes it backs, and refreshes its age when it is seen again", async () => {
    await sql`truncate payloads`;
    await insertPayloads(sql, [{ hash: "h1", body: "one" }, { hash: "h1", body: "one" }, { hash: "h2", body: "two" }]);
    expect((await sql`select payload_hash from payloads order by payload_hash`).map((r) => r.payload_hash)).toEqual(["h1", "h2"]);
    await sql`update payloads set stored_at = now() - interval '40 days' where payload_hash = 'h1'`;
    await insertPayloads(sql, [{ hash: "h1", body: "one" }]);
    expect(await prunePayloads(sql, new Date())).toBe(0);
    await insertPayloads(sql, []);
  });
  it("retention deletes only payloads older than 30 days", async () => {
    expect(PAYLOAD_RETENTION_DAYS).toBe(30);
    await sql`truncate payloads`;
    const now = new Date("2026-11-30T14:05:00Z");
    const at = (days: number): Date => new Date(now.getTime() - days * DAY);
    await sql`insert into payloads (payload_hash, body, stored_at) values ('old', 'x', ${at(31)}), ('edge', 'x', ${at(30)}), ('young', 'x', ${at(29)}), ('new', 'x', ${now})`;
    expect(await prunePayloads(sql, now)).toBe(1);
    expect((await sql`select payload_hash from payloads order by payload_hash`).map((r) => r.payload_hash)).toEqual(["edge", "new", "young"]);
  });
});
