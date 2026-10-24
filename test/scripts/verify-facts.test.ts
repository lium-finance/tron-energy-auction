import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, insertVerification, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { factEnv } from "../../src/scripts/env.js";
import { UTILISATION_MEASURES, parseRangeArgs, supplierFact, utilisationFact, verificationRows } from "../../src/scripts/verify-facts.js";
import type { Wallets } from "../../src/index/wallet-list.js";
import { testDbUrl as url } from "../index/testdb.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;
const run = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync(tsx, [`src/scripts/${script}.ts`, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ENV_FILE: "/nonexistent/.env", ...env }, encoding: "utf8", timeout: 20_000 });

const addr = (c: string): string => `T${c}${"3".repeat(32)}`;
const S1 = addr("a");
const S2 = addr("b");
const TOP1 = addr("c");
const TOP2 = addr("d");
const OTHER = addr("e");
const wallets = (supplier: string[], top: string[], stakeTotals: Wallets["top100"]["stakeTotals"] = null): Wallets => ({ supplier, top100: { source: "fixture", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.42, wallets: top, stakeTotals } });

const H0 = 600_000;

/**
 * One wallet's hourly reads under java-tron's decay: every hour the stored usage decays by 1/24 and the hour's burn is
 * added (stored = stored * 23/24 + burnPerDay / 24), starting from the steady state (stored = burnPerDay) unless `stored` says otherwise. The stored
 * value is what getaccountresource returns as EnergyUsed; it is rounded to a whole unit like the bigint column.
 */
async function simulate(sql: Sql, wallet: string, energyLimit: number, burnPerDay: number, o: { from?: number; hours?: number; skip?: number[]; stored?: number } = {}) {
  const from = o.from ?? H0;
  let stored = o.stored ?? burnPerDay;
  for (let h = from; h < from + (o.hours ?? 25); h++) {
    stored = (stored * 23) / 24 + burnPerDay / 24;
    if (o.skip?.includes(h)) continue;
    await insertVerification(sql, { hour: h, wallet, energyLimit, energyUsed: Math.round(stored), readAt: new Date(), source: "fixture" });
  }
}

describe("parseRangeArgs", () => {
  it("defaults to null (the latest 27 stored hours), a from alone covers 27 hours, both are inclusive", () => {
    expect(parseRangeArgs(undefined, undefined)).toBeNull();
    expect(parseRangeArgs("1000", undefined)).toEqual({ from: 1000, to: 1026 });
    expect(parseRangeArgs("1000", "1030")).toEqual({ from: 1000, to: 1030 });
  });
  it("rejects anything that is not a whole unix hour, and a to before from, as a ConfigError", () => {
    for (const bad of ["-1", "1.5", "abc", "", "1e3"]) expect(() => parseRangeArgs(bad, undefined)).toThrow(expect.objectContaining({ name: "ConfigError" }));
    expect(() => parseRangeArgs("10", "x")).toThrow('to must be a unix hour; got "x"');
    expect(() => parseRangeArgs("10", "9")).toThrow("to (9) is before from (10)");
  });
});

describe.skipIf(!url)("verification facts over stored rows", () => {
  let sql: Sql;
  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!);
  });
  beforeEach(async () => {
    await sql`truncate verification`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("queries per-wallet, per-hour rows for the listed wallets only, inside the range", async () => {
    await simulate(sql, S1, 100, 24, { from: H0 - 5, hours: 35 });
    await simulate(sql, OTHER, 100, 24, { from: H0, hours: 25 });
    const latest = await verificationRows(sql, [S1], null);
    expect({ from: latest.from, to: latest.to, n: latest.rows.length }).toEqual({ from: H0 + 3, to: H0 + 29, n: 27 });
    expect(latest.rows.every((r) => r.wallet === S1)).toBe(true);
    expect(latest.rows[0]).toEqual({ wallet: S1, hour: H0 + 3, energyLimit: 100, energyUsed: expect.any(Number) });
    const explicit = await verificationRows(sql, [S1, OTHER], { from: H0, to: H0 + 2 });
    expect(explicit.rows.map((r) => [r.wallet, r.hour])).toEqual([[S1, H0], [S1, H0 + 1], [S1, H0 + 2], [OTHER, H0], [OTHER, H0 + 1], [OTHER, H0 + 2]]);
    expect(await verificationRows(sql, [TOP1], null)).toEqual({ from: null, to: null, rows: [] });
  });

  it("supplier: a full simulated day with 230M idle passes; burn is rebuilt from the decaying EnergyUsed, not read off it", async () => {
    await simulate(sql, S1, 180_000_000, 30_000_000);
    await simulate(sql, S2, 100_000_000, 20_000_000);
    const f = await supplierFact(sql, wallets([S1, S2], [TOP1]), null);
    expect(f).toMatchObject({ fact: "supplier", from: H0 - 2, to: H0 + 24, rows: 50, pass: true, complete: true, wallets: 2, walletsListed: 2, walletsMissing: 0, marginal: false });
    expect(Math.abs(f.idleUnitsPerDay - 230_000_000)).toBeLessThanOrEqual(50);
  });

  it("supplier: a full simulated day with 180M idle fails, complete, though the raw EnergyUsed snapshot would have passed it", async () => {
    // Both wallets start idle (stored 0), so after 25 hours the snapshot is only about 66 % of what was burned:
    // limit minus the last EnergyUsed would be about 204M and pass; the rebuilt burn gives 180M.
    await simulate(sql, S1, 180_000_000, 30_000_000, { stored: 0 });
    await simulate(sql, S2, 100_000_000, 70_000_000, { stored: 0 });
    const snapshotIdle = (await sql<{ idle: string }[]>`select sum(energy_limit - energy_used)::text as idle from verification where hour = ${H0 + 24}`)[0]!.idle;
    expect(Number(snapshotIdle)).toBeGreaterThan(200_000_000);
    const f = await supplierFact(sql, wallets([S1, S2], [TOP1]), { from: H0, to: H0 + 24 });
    expect(f).toMatchObject({ pass: false, complete: true, wallets: 2, marginal: false });
    expect(Math.abs(f.idleUnitsPerDay - 180_000_000)).toBeLessThanOrEqual(50);
  });

  it("supplier: within 2 % of the threshold is marginal", async () => {
    await simulate(sql, S1, 300_000_000, 97_000_000);
    const f = await supplierFact(sql, wallets([S1], [TOP1]), null);
    expect(f).toMatchObject({ pass: true, marginal: true });
  });

  it("supplier: a listed wallet with no reads, or a wallet with more than 2 unread hours, makes it incomplete and not a pass", async () => {
    await simulate(sql, S1, 900_000_000, 1_000_000);
    expect(await supplierFact(sql, wallets([S1, S2], [TOP1]), null)).toMatchObject({ pass: false, complete: false, wallets: 1, walletsListed: 2, walletsMissing: 1 });
    await simulate(sql, S2, 900_000_000, 1_000_000, { skip: [H0 + 3, H0 + 4, H0 + 5] });
    expect(await supplierFact(sql, wallets([S1, S2], [TOP1]), null)).toMatchObject({ pass: false, complete: false, wallets: 2, walletsMissing: 0 });
  });

  it("supplier: two unread hours are still a full day (uses inside a gap are netted, so the figure is an estimate)", async () => {
    await simulate(sql, S1, 300_000_000, 48_000_000, { skip: [H0 + 3, H0 + 10] });
    const f = await supplierFact(sql, wallets([S1], [TOP1]), null);
    expect(f).toMatchObject({ pass: true, complete: true, rows: 23 });
    expect(Math.abs(f.idleUnitsPerDay - 252_000_000)).toBeLessThanOrEqual(252_000_000 * 0.002);
  });

  it("a wallet missing the window's latest hour (still being read when the fact runs) or its first hour is still complete", async () => {
    // S1 has hours H0..H0+26; S2's newest read (H0+26) has not landed yet; the window is the latest 27 hours, H0..H0+26.
    await simulate(sql, S1, 300_000_000, 48_000_000, { hours: 27 });
    await simulate(sql, S2, 300_000_000, 48_000_000, { hours: 26 });
    const mid = await supplierFact(sql, wallets([S1, S2], [TOP1]), null);
    expect(mid).toMatchObject({ from: H0, to: H0 + 26, pass: true, complete: true, wallets: 2, walletsMissing: 0 });
    // and one that missed the window's first hour
    await sql`delete from verification where wallet = ${S1} and hour = ${H0}`;
    expect(await supplierFact(sql, wallets([S1, S2], [TOP1]), null)).toMatchObject({ pass: true, complete: true, wallets: 2 });
    // the same in the utilisation fact
    await simulate(sql, TOP1, 100_000_000, 90_000_000, { from: H0 + 1, hours: 26 });
    await simulate(sql, TOP2, 100_000_000, 90_000_000, { hours: 26 });
    expect(await utilisationFact(sql, wallets([S1], [TOP1, TOP2]), null)).toMatchObject({ from: H0, to: H0 + 26, pass: true, complete: true, wallets: 2 });
  });

  it("a from-only window covers 27 hours, so the edge-hour cases hold there too", async () => {
    await simulate(sql, S1, 300_000_000, 48_000_000, { from: H0 + 1, hours: 25 });
    expect(await supplierFact(sql, wallets([S1], [TOP1]), parseRangeArgs(String(H0), undefined))).toMatchObject({ from: H0, to: H0 + 26, pass: true, complete: true });
  });

  it("reports how old the window's last hour is, and stale when more than 2 hours", async () => {
    await simulate(sql, S1, 300_000_000, 48_000_000);
    const at = (h: number) => new Date(h * 3_600_000 + 60_000);
    expect(await supplierFact(sql, wallets([S1], [TOP1]), null, at(H0 + 24))).toMatchObject({ to: H0 + 24, hoursSinceTo: 0, stale: false });
    expect(await supplierFact(sql, wallets([S1], [TOP1]), null, at(H0 + 26))).toMatchObject({ hoursSinceTo: 2, stale: false });
    expect(await utilisationFact(sql, wallets([S1], [S1]), null, at(H0 + 27))).toMatchObject({ hoursSinceTo: 3, stale: true });
    expect(await supplierFact(sql, wallets([TOP1], [TOP2]), null, at(H0 + 27))).toMatchObject({ to: null, hoursSinceTo: null, stale: false });
  });

  it("utilisation: 90 % burned over a full day is scarcity and a pass; carries the list's source, date and share", async () => {
    await simulate(sql, TOP1, 100_000_000, 90_000_000);
    await simulate(sql, TOP2, 300_000_000, 270_000_000);
    const f = await utilisationFact(sql, wallets([S1], [TOP1, TOP2]), null);
    expect(f).toMatchObject({ fact: "utilisation", rows: 50, listSource: "fixture", listReadAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.42, pass: true, framing: "scarcity", complete: true, wallets: 2, walletsMissing: 0, marginal: false });
    expect(f.utilisation).toBeCloseTo(0.9, 6);
  });

  it("utilisation states what it measures, and the list's delegated-out share beside it (null without stake numbers)", async () => {
    await simulate(sql, TOP1, 100_000_000, 90_000_000);
    const plain = await utilisationFact(sql, wallets([S1], [TOP1]), null);
    expect(plain).toMatchObject({ delegatedOutShare: null, measures: UTILISATION_MEASURES, framing: "scarcity" });
    expect(plain.measures).toContain("lower bound");
    expect(plain.passCondition).toBe("energy burned per day / energy limit (from hourly deltas) >= 85 % is scarcity, the pass; < 70 % markup market; every listed wallet with a full day of reads");
    const withStakes = await utilisationFact(sql, wallets([S1], [TOP1], { energyStakeTrx: 3_000, delegatedOutTrx: 1_000 }), null);
    expect(withStakes).toMatchObject({ delegatedOutShare: 0.333333, utilisation: plain.utilisation, pass: plain.pass });
    expect((await utilisationFact(sql, wallets([S1], [TOP1], { energyStakeTrx: 0, delegatedOutTrx: 0 }), null)).delegatedOutShare).toBeNull();
  });

  it("utilisation: 50 % is a markup market, not a pass; near 70 % is marginal", async () => {
    await simulate(sql, TOP1, 100_000_000, 50_000_000);
    expect(await utilisationFact(sql, wallets([S1], [TOP1]), null)).toMatchObject({ pass: false, framing: "markup", complete: true, marginal: false });
    await sql`truncate verification`;
    await simulate(sql, TOP1, 100_000_000, 70_500_000);
    expect(await utilisationFact(sql, wallets([S1], [TOP1]), null)).toMatchObject({ framing: "neither", marginal: true });
  });

  it("utilisation: a listed wallet never read, or one short of a full day, is not a pass", async () => {
    await simulate(sql, TOP1, 100_000_000, 95_000_000);
    expect(await utilisationFact(sql, wallets([S1], [TOP1, TOP2]), null)).toMatchObject({ pass: false, framing: "scarcity", complete: false, wallets: 1, walletsMissing: 1 });
    await simulate(sql, TOP2, 100_000_000, 95_000_000, { hours: 20 });
    expect(await utilisationFact(sql, wallets([S1], [TOP1, TOP2]), null)).toMatchObject({ pass: false, complete: false, wallets: 1, walletsMissing: 0 });
  });

  it("no rows: insufficient, null range", async () => {
    expect(await utilisationFact(sql, wallets([S1], [TOP1]), null)).toMatchObject({ from: null, to: null, rows: 0, pass: false, framing: "insufficient", utilisation: null, complete: false, marginal: false });
    expect(await supplierFact(sql, wallets([S1], [TOP1]), null)).toMatchObject({ from: null, to: null, rows: 0, pass: false, idleUnitsPerDay: 0, complete: false, marginal: false });
  });

  it("the scripts print exactly one JSON line on stdout, the same as the fact", async () => {
    await simulate(sql, S1, 180_000_000, 30_000_000);
    await simulate(sql, S2, 100_000_000, 20_000_000);
    await simulate(sql, TOP1, 100_000_000, 90_000_000);
    // The file gives the top-100 wallets in the builder's object form, with stake numbers.
    const w = wallets([S1, S2], [TOP1], { energyStakeTrx: 400, delegatedOutTrx: 100 });
    const file = join(mkdtempSync(join(tmpdir(), "wallets-")), "wallets.json");
    writeFileSync(file, JSON.stringify({ supplier: w.supplier, top100: { ...w.top100, stakeTotals: undefined, wallets: [{ address: TOP1, energyStakeTrx: 400, delegatedOutTrx: 100 }] } }));
    // No TRONGRID_API_KEY: the fact scripts never call an API.
    const env = { DATABASE_URL: url!, VERIFY_WALLETS_FILE: file };
    const s = run("verify-supplier", [], env);
    expect(s.status).toBe(0);
    expect(s.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(s.stdout)).toEqual(await supplierFact(sql, w, null));
    const u = run("verify-utilisation", [String(H0), String(H0 + 24)], env);
    expect(u.status).toBe(0);
    expect(JSON.parse(u.stdout)).toEqual(await utilisationFact(sql, w, { from: H0, to: H0 + 24 }));
    expect(JSON.parse(u.stdout)).toMatchObject({ delegatedOutShare: 0.25, measures: UTILISATION_MEASURES });
  });
});

describe("factEnv", () => {
  it("needs only DATABASE_URL and VERIFY_WALLETS_FILE, trimmed", () => {
    expect(factEnv({ DATABASE_URL: " postgres://x/y ", VERIFY_WALLETS_FILE: " w.json " })).toEqual({ databaseUrl: "postgres://x/y", walletsFile: "w.json" });
    expect(() => factEnv({ VERIFY_WALLETS_FILE: "w.json" })).toThrow(expect.objectContaining({ name: "ConfigError", message: "DATABASE_URL is required" }));
    expect(() => factEnv({ DATABASE_URL: "postgres://x/y", VERIFY_WALLETS_FILE: "  " })).toThrow("VERIFY_WALLETS_FILE is required");
  });
});

describe("verify-supplier and verify-utilisation", () => {
  const env = { DATABASE_URL: "postgres://nobody@localhost:1/none_test" };
  it("exit 2 naming DATABASE_URL when it is unset (and never ask for TRONGRID_API_KEY)", () => {
    const r = run("verify-supplier", [], { VERIFY_WALLETS_FILE: "w.json" });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("ConfigError: DATABASE_URL is required");
  });
  it("exit 2 naming VERIFY_WALLETS_FILE when it is unset, before touching the database", () => {
    for (const script of ["verify-supplier", "verify-utilisation"]) {
      const r = run(script, [], env);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr.trim()).toBe("ConfigError: VERIFY_WALLETS_FILE is required");
    }
  });
  it("exit 2 for a bad hour argument and for a malformed wallets file", () => {
    expect(run("verify-supplier", ["abc"], env).status).toBe(2);
    const file = join(mkdtempSync(join(tmpdir(), "wallets-")), "wallets.json");
    writeFileSync(file, '{"supplier":["nope"]}');
    const r = run("verify-utilisation", [], { ...env, VERIFY_WALLETS_FILE: file });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("ConfigError: supplier[0] is not a Tron address");
  });
});
