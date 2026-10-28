import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Quote } from "../../src/core/types.js";
import { createDb, insertChain, insertQuotes, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { bidsInside, clearabilityDefaults, clearabilityFact, parseClearabilityArgs, resolveInputs, type Defaults, type Input } from "../../src/scripts/clearability.js";
import { testDbUrl as url } from "../index/testdb.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(tsx, ["src/scripts/verify-clearability.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ENV_FILE: "/nonexistent/.env", ...env }, encoding: "utf8", timeout: 20_000 });

const flag = (value: number): Input => ({ value, source: "flag", hour: null });
const dflt = (value = 100): Input => ({ value, source: "default", hour: null });
const db = (value: number, hour: number, venue?: string): Input => ({ value, source: "db", hour, ...(venue ? { venue } : {}) });
const noDb: Defaults = { window: null, paired: null, latestNet: null, latestDealer: null, burn: dflt() };
const flags = (net: number, dealer: number, burn: number) => resolveInputs({ net, dealer, burn }, noDb);
const NOW = new Date(800_000 * 3_600_000);

describe("clearabilityFact", () => {
  it("the task's numbers (35.4 / 44 / 100): both rules clear at the supplier's reserve, 35.4, for 2 and 3 bidders", () => {
    const f = clearabilityFact(flags(35.4, 44, 100), null, NOW);
    expect(f).toMatchObject({ pass: true, reason: null, hour: null, hoursSinceTo: null, stale: false, bandWidthSun: 8.6, note: "passes by construction whenever a band exists; read with verify-band" });
    expect(f.cases.map((c) => c.bidders)).toEqual([2, 3]);
    expect(f.cases[0]!.bids).toEqual([{ priceSun: 38.2667, energy: 20_000_000 }, { priceSun: 41.1333, energy: 20_000_000 }]);
    expect(f.cases[1]!.bids.map((b) => b.priceSun)).toEqual([37.55, 39.7, 41.85]);
    for (const c of f.cases) {
      expect(c.corrected).toMatchObject({ priceSun: 35.4, energy: 20_000_000 * c.bidders });
      expect(c.corrected.awards).toHaveLength(c.bidders);
      expect(c.research).toEqual({ priceSun: 35.4, energy: 20_000_000 * c.bidders });
    }
    expect(f).toMatchObject({ supplier: { askSun: 35.4, energy: 200_000_000 }, capShare: 0.35, window: null });
  });
  it("live-like numbers (net 46.99, dealer 60.5, burn 100) clear at 46.99 under the corrected rule", () => {
    const f = clearabilityFact(flags(46.99, 60.5, 100), null, NOW);
    expect(f).toMatchObject({ pass: true, bandWidthSun: 13.51 });
    expect(f.cases.map((c) => c.corrected.priceSun)).toEqual([46.99, 46.99]);
    for (const c of f.cases) for (const b of c.bids) expect(b.priceSun > 46.99 && b.priceSun < 60.5).toBe(true);
  });
  it("narrow bands: bids are clamped strictly inside; a band narrower than (n + 1) * 0.0001 is band-too-narrow, pass false", () => {
    expect(bidsInside(46.99, 46.9904, 3).map((b) => b.priceSun)).toEqual([46.9901, 46.9902, 46.9903]);
    expect(bidsInside(46.99, 46.9904, 2).map((b) => b.priceSun)).toEqual([46.9901, 46.9903]);
    expect(clearabilityFact(flags(46.99, 46.9904, 100), null, NOW)).toMatchObject({ pass: true, reason: null });
    const f = clearabilityFact(flags(46.99, 46.9901, 100), null, NOW);
    expect(f).toMatchObject({ pass: false, reason: "band-too-narrow", bandWidthSun: 0.0001, cases: [] });
  });
  it("net and dealer from the same stored hour: reports that hour, how old it is, and stale after 2 hours", () => {
    const d: Defaults = { window: { from: 799_977, to: 800_000 }, paired: { hour: 799_997, net: db(46.99, 799_997), dealer: db(60.5, 799_997, "tronsave") }, latestNet: db(47, 800_000), latestDealer: db(61, 799_999, "netts"), burn: db(100, 800_000) };
    const f = clearabilityFact(resolveInputs({}, d), d.window, NOW);
    expect(f).toMatchObject({ pass: true, hour: 799_997, hoursSinceTo: 3, stale: true, bandWidthSun: 13.51, inputs: { netSun: db(46.99, 799_997), dealerSun: db(60.5, 799_997, "tronsave") } });
    // A flag overrides one input; the other then comes from its own latest stored hour.
    expect(clearabilityFact(resolveInputs({ dealer: 70 }, d), d.window, NOW)).toMatchObject({ hour: 800_000, hoursSinceTo: 0, inputs: { netSun: db(47, 800_000), dealerSun: flag(70) } });
    expect(clearabilityFact(resolveInputs({ net: 40 }, d), d.window, NOW)).toMatchObject({ hour: 799_999, inputs: { netSun: flag(40), dealerSun: db(61, 799_999, "netts") } });
  });
});

describe("parseClearabilityArgs and resolveInputs", () => {
  it("parses --net/--dealer/--burn as a separate or = value", () => {
    expect(parseClearabilityArgs([])).toEqual({});
    expect(parseClearabilityArgs(["--net", "46.99", "--dealer=60.5", "--burn", "100"])).toEqual({ net: 46.99, dealer: 60.5, burn: 100 });
    expect(parseClearabilityArgs(["--dealer", "46.9901"])).toEqual({ dealer: 46.9901 });
  });
  it("rejects a value that is not a finite positive number with at most 4 decimals, a missing value, a repeat and an unknown argument, as a ConfigError", () => {
    for (const bad of [["--net", "0"], ["--net", "-1"], ["--net", "abc"], ["--net", "Infinity"], ["--net", "NaN"], ["--net", ""], ["--net"], ["--net", "1", "--net", "2"], ["--max", "1"], ["46"], ["--net", "46.99001"], ["--net", "1e3"]]) {
      expect(() => parseClearabilityArgs(bad)).toThrow(expect.objectContaining({ name: "ConfigError" }));
    }
  });
  it("a failed relation that involves a flag is a ConfigError", () => {
    expect(() => resolveInputs({ net: 50, dealer: 50 }, noDb)).toThrow("no band to bid inside: dealer 50 (flag) is not above net 50 (flag)");
    expect(() => resolveInputs({ net: 50, dealer: 120 }, noDb)).toThrow("dealer 120 (flag) is above burn 100 (default)");
    const d: Defaults = { ...noDb, paired: { hour: 5, net: db(46.99, 5), dealer: db(60.5, 5, "tronsave") }, latestNet: db(46.99, 5), latestDealer: db(60.5, 5, "tronsave") };
    expect(() => resolveInputs({ net: 70 }, d)).toThrow("no band to bid inside: dealer 60.5 (db, hour 5) is not above net 70 (flag)");
    expect(() => resolveInputs({ burn: 50 }, d)).toThrow("dealer 60.5 (db, hour 5) is above burn 50 (flag)");
  });
  it("a failed check on stored inputs only is a result with a reason code, never an error", () => {
    const at = (d: Partial<Defaults>) => clearabilityFact(resolveInputs({}, { ...noDb, window: { from: 1, to: 24 }, ...d }), { from: 1, to: 24 }, NOW);
    expect(at({})).toMatchObject({ pass: false, reason: "no-net-rate", cases: [], inputs: { netSun: null, dealerSun: null, burnSun: dflt() } });
    // Net rates and dealer quotes both stored, but never in the same hour: no-paired-hour, not no-dealer-quote.
    const unpaired = at({ latestNet: db(35.4, 20), latestDealer: db(44, 19, "tronsave") });
    expect(unpaired).toMatchObject({ pass: false, reason: "no-paired-hour", cases: [], inputs: { netSun: null, dealerSun: null } });
    expect(unpaired.message).toContain("never in the same hour");
    expect(at({ latestNet: db(35.4, 20) })).toMatchObject({ pass: false, reason: "no-dealer-quote", inputs: { netSun: null, dealerSun: null } });
    // With --net given, a missing dealer quote is still no-dealer-quote.
    expect(clearabilityFact(resolveInputs({ net: 35.4 }, { ...noDb, window: { from: 1, to: 24 } }), null, NOW)).toMatchObject({ pass: false, reason: "no-dealer-quote" });
    expect(at({ paired: { hour: 20, net: db(46.99, 20), dealer: db(45, 20, "tronsave") } })).toMatchObject({ pass: false, reason: "no-band", hour: 20, bandWidthSun: -1.99, inputs: { netSun: db(46.99, 20), dealerSun: db(45, 20, "tronsave") } });
    expect(at({ paired: { hour: 20, net: db(46.99, 20), dealer: db(120, 20, "tronsave") } })).toMatchObject({ pass: false, reason: "dealer-above-burn", inputs: { burnSun: dflt() } });
    expect(at({ paired: { hour: 20, net: db(46.99, 20), dealer: db(46.9902, 20, "tronsave") } })).toMatchObject({ pass: false, reason: "band-too-narrow" });
    for (const r of [at({}), at({ paired: { hour: 20, net: db(46.99, 20), dealer: db(45, 20, "tronsave") } })]) expect(r.message).toEqual(expect.any(String));
  });
});

describe("verify-clearability without a database", () => {
  it("with all three flags it needs no DATABASE_URL and prints one JSON line", () => {
    const r = run(["--net", "35.4", "--dealer", "44", "--burn", "100"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual(JSON.parse(JSON.stringify(clearabilityFact(flags(35.4, 44, 100), null))));
    expect(out).toMatchObject({ pass: true, hour: null, hoursSinceTo: null, stale: false });
  });
  it("46.99 / 46.9901 by flag is a band-too-narrow result, exit 0", () => {
    const r = run(["--net", "46.99", "--dealer", "46.9901", "--burn", "100"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ pass: false, reason: "band-too-narrow", bandWidthSun: 0.0001 });
  });
  it("exits 2 for a bad flag before anything else, and names DATABASE_URL when it needs the database", () => {
    const bad = run(["--net", "abc"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr.trim()).toBe('ConfigError: --net must be a positive number of sun with at most 4 decimals; got "abc"');
    expect(run(["--net", "46.99001", "--dealer", "50", "--burn", "100"]).status).toBe(2);
    const r = run(["--net", "35.4"]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("ConfigError: DATABASE_URL is required");
    expect(run(["--net", "50", "--dealer", "40", "--burn", "100"]).status).toBe(2);
  });
});

const H0 = 710_000;
const q = (hour: number, venue: string, sun: number, over: Partial<Quote> = {}): Quote => ({ hour, venue, size: 20_000_000, term: "1h", sunPerUnit: sun, depth: 20_000_000, readAt: new Date(hour * 3_600_000), source: "t", status: "ok", reason: null, payloadHash: null, ...over });
const net = (hour: number, sun: number): Quote => q(hour, "justlend-net", sun, { term: "1d", depth: null, status: "depth-unknown" });
const chain = (hour: number, fee: number) => ({ hour, energyFeeSun: fee, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() });

describe.skipIf(!url)("clearability inputs from stored rows", () => {
  let sql: Sql;
  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!);
  });
  beforeEach(async () => {
    await sql`truncate quotes, chain`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("defaults: net and the cheapest dealer quote from the latest hour that has both, the latest of each alone, the newest chain fee", async () => {
    await insertQuotes(sql, [
      net(H0, 35), q(H0, "tronsave", 50), q(H0, "netts", 40),
      net(H0 + 1, 46.99), q(H0 + 1, "tronsave", 60.5), q(H0 + 1, "netts", 70), q(H0 + 1, "tronbid", 55, { status: "no-depth", depth: 5_000_000 }),
      q(H0 + 2, "tronsave", 61), net(H0 + 3, 47),
      q(H0 + 4, "tronsave", 62, { status: "failed", sunPerUnit: null, depth: null }),
    ]);
    await insertChain(sql, chain(H0, 100));
    await insertChain(sql, chain(H0 + 1, 210));
    const d = await clearabilityDefaults(sql);
    expect(d).toEqual({
      window: { from: H0 + 4 - 23, to: H0 + 4 },
      paired: { hour: H0 + 1, net: db(46.99, H0 + 1), dealer: db(60.5, H0 + 1, "tronsave") },
      latestNet: db(47, H0 + 3),
      latestDealer: db(61, H0 + 2, "tronsave"),
      burn: db(210, H0 + 1),
    });
    expect(resolveInputs({ burn: 300 }, d)).toMatchObject({ net: { source: "db", hour: H0 + 1 }, dealer: { source: "db", hour: H0 + 1 }, burn: flag(300) });
  });

  it("no chain row: burn 100 by default; no hour with a depth-aware quote beside a net rate: a no-dealer-quote result, exit 0, unless --dealer is given", async () => {
    await insertQuotes(sql, [net(H0, 35.4), q(H0, "getblock", 30, { status: "depth-unknown", depth: null })]);
    expect(await clearabilityDefaults(sql)).toMatchObject({ paired: null, latestNet: { value: 35.4 }, latestDealer: null, burn: { value: 100, source: "default", hour: null } });
    const r = run([], { DATABASE_URL: url! });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ pass: false, reason: "no-dealer-quote", message: expect.stringContaining(`in hours ${H0 - 23} to ${H0}`) });
    const ok = run(["--dealer", "44"], { DATABASE_URL: url! });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ pass: true, hour: H0, inputs: { netSun: { value: 35.4, source: "db", hour: H0 }, dealerSun: { value: 44, source: "flag" }, burnSun: { value: 100, source: "default" } } });
  });

  it("never takes a collect-only venue's quote as the dealer default: the record is public", async () => {
    await insertQuotes(sql, [net(H0, 35), q(H0, "tronsave", 50), q(H0, "gated", 40), q(H0 + 1, "gated", 41)]);
    expect(await clearabilityDefaults(sql, new Set())).toMatchObject({ paired: { dealer: db(40, H0, "gated") }, latestDealer: db(41, H0 + 1, "gated") });
    const d = await clearabilityDefaults(sql, new Set(["gated"]));
    expect(d).toMatchObject({ paired: { dealer: db(50, H0, "tronsave") }, latestDealer: db(50, H0, "tronsave") });
  });

  it("net rates and dealer quotes stored in different hours only: a no-paired-hour result, exit 0", async () => {
    await insertQuotes(sql, [net(H0, 35.4), q(H0 + 1, "tronsave", 44)]);
    expect(await clearabilityDefaults(sql)).toMatchObject({ paired: null, latestNet: { value: 35.4 }, latestDealer: { value: 44 } });
    const r = run([], { DATABASE_URL: url! });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ pass: false, reason: "no-paired-hour", cases: [] });
  });

  it("no band in the stored hour is a no-band result, exit 0; the same with a flag is exit 2", async () => {
    await insertQuotes(sql, [net(H0, 46.99), q(H0, "tronsave", 45)]);
    const r = run([], { DATABASE_URL: url! });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ pass: false, reason: "no-band", hour: H0, bandWidthSun: -1.99 });
    expect(run(["--net", "50"], { DATABASE_URL: url! }).status).toBe(2);
  });

  it("the script prints exactly one JSON line on stdout, the same as the fact over the database defaults", async () => {
    await insertQuotes(sql, [net(H0, 46.99), q(H0, "tronsave", 60.5)]);
    await insertChain(sql, chain(H0, 100));
    const r = run([], { DATABASE_URL: url! });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const d = await clearabilityDefaults(sql);
    const out = JSON.parse(r.stdout);
    expect({ ...out, hoursSinceTo: 0, stale: false }).toEqual({ ...JSON.parse(JSON.stringify(clearabilityFact(resolveInputs({}, d), d.window))), hoursSinceTo: 0, stale: false });
    expect(out).toMatchObject({ pass: true, hour: H0, bandWidthSun: 13.51, cases: [{ corrected: { priceSun: 46.99 } }, { corrected: { priceSun: 46.99 } }] });
  });
});
