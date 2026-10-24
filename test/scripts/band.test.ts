import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Quote } from "../../src/core/types.js";
import { createDb, insertQuotes, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { TERM_NOTE, assembleBandHours, bandFact, defaultBandWindow, venueTermPremiums } from "../../src/scripts/band.js";
import { databaseEnv } from "../../src/scripts/env.js";
import { parseRangeArgs } from "../../src/scripts/verify-facts.js";
import { testDbUrl as url } from "../index/testdb.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;
const run = (args: string[], env: Record<string, string>) =>
  spawnSync(tsx, ["src/scripts/verify-band.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ENV_FILE: "/nonexistent/.env", ...env }, encoding: "utf8", timeout: 20_000 });

const q = (hour: number, venue: string, sun: number, over: Partial<Quote> = {}): Quote => ({ hour, venue, size: 20_000_000, term: "1h", sunPerUnit: sun, depth: 20_000_000, readAt: new Date(hour * 3_600_000), source: "t", status: "ok", reason: null, payloadHash: null, ...over });
const net = (hour: number, sun: number): Quote => q(hour, "justlend-net", sun, { term: "1d", depth: null, status: "depth-unknown" });
const term = (hour: number, venue: string, t: Quote["term"], sun: number, over: Partial<Quote> = {}): Quote => q(hour, venue, sun, { term: t, ...over });

describe("assembleBandHours", () => {
  it("pairs each hour's cheapest 20M-depth ok quote with that hour's justlend-net rate", () => {
    const hours = assembleBandHours([q(1, "a", 42), q(1, "b", 40), q(1, "c", 30, { status: "no-depth", depth: 5_000_000 }), net(1, 35.4), q(2, "a", 41), net(2, 36)]);
    expect(hours).toEqual([{ hour: 1, cheapestSun: 40, cheapestVenue: "b", justlendNetSun: 35.4 }, { hour: 2, cheapestSun: 41, cheapestVenue: "a", justlendNetSun: 36 }]);
  });
  it("drops an hour with no justlend-net row and marks an hour with no depth-aware quote as null", () => {
    expect(assembleBandHours([q(3, "a", 40)])).toEqual([]);
    expect(assembleBandHours([net(4, 35)])).toEqual([{ hour: 4, cheapestSun: null, cheapestVenue: null, justlendNetSun: 35 }]);
  });
  it("counts only ok, 1h, 20M quotes whose depth covers 20M with a positive price; a failed net row is no rate", () => {
    const hours = assembleBandHours([
      net(5, 35),
      q(5, "unknown", 10, { status: "depth-unknown", depth: null }),
      q(5, "ok-but-shallow", 11, { depth: 19_999_999 }),
      q(5, "small", 12, { size: 5_000_000, depth: 5_000_000 }),
      q(5, "daily", 13, { term: "1d" }),
      q(5, "rejected", 14, { status: "rejected" }),
      q(5, "zero", 0),
      q(5, "good", 45),
      q(6, "justlend-net", 0, { term: "1d", status: "failed", sunPerUnit: null }),
      q(6, "good", 45),
    ]);
    expect(hours).toEqual([{ hour: 5, cheapestSun: 45, cheapestVenue: "good", justlendNetSun: 35 }]);
  });
});

describe("venueTermPremiums", () => {
  const hoursOf = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);
  it("compares each venue's own terms at 20M over paired hours: TronSave's 7d/14d above its 1d is a premium; JustLend (1d only) and justlend-net are not compared", () => {
    const quotes: Quote[] = [];
    for (const h of hoursOf(1, 12)) {
      quotes.push(term(h, "tronsave", "1d", 78), term(h, "tronsave", "7d", 99), term(h, "tronsave", "14d", 99));
      // A 65,000-unit 7-day order is cheaper per unit-day, but it is not the instrument's size.
      quotes.push(term(h, "tronsave", "7d", 42.25, { size: 65_000, depth: 65_000 }));
      quotes.push(term(h, "justlend", "1d", 44.2, { depth: null, status: "depth-unknown" }));
      quotes.push(net(h, 35.4), term(h, "justlend-net", "7d", 90, { depth: null, status: "depth-unknown" }));
    }
    const premium = { pairedHours: 12, d1PerDay: 78, termPerDay: 99, premium: 0.2692, exists: true };
    expect(venueTermPremiums(quotes)).toEqual({
      exists: true,
      minPairedHours: 12,
      venues: [{ venue: "tronsave", terms: { "7d": premium, "14d": premium }, exists: true }],
      venuesWithoutTerm: ["justlend"],
      note: TERM_NOTE,
    });
  });
  it("a skewed sample: 1d at 40 for 20 hours and 45 for 4, 7d at 46 only in those 4: about 2 % over the paired hours, no premium", () => {
    const quotes: Quote[] = [];
    for (const h of hoursOf(1, 20)) quotes.push(term(h, "v", "1d", 40));
    for (const h of hoursOf(21, 4)) quotes.push(term(h, "v", "1d", 45), term(h, "v", "7d", 46));
    expect(venueTermPremiums(quotes)).toMatchObject({
      exists: false,
      venues: [{ venue: "v", exists: false, terms: { "7d": { pairedHours: 4, d1PerDay: 45, termPerDay: 46, premium: 0.0222, exists: false }, "14d": { pairedHours: 0, d1PerDay: null, termPerDay: null, premium: null, exists: false } } }],
    });
  });
  it("a premium of 10 % or more over fewer than 12 paired hours does not exist; 12 or more does", () => {
    const at = (n: number): Quote[] => hoursOf(1, n).flatMap((h) => [term(h, "v", "1d", 50), term(h, "v", "14d", 60)]);
    expect(venueTermPremiums(at(11))).toMatchObject({ exists: false, venues: [{ terms: { "14d": { pairedHours: 11, premium: 0.2, exists: false } } }] });
    expect(venueTermPremiums(at(12))).toMatchObject({ exists: true, venues: [{ terms: { "14d": { pairedHours: 12, premium: 0.2, exists: true } } }] });
  });
  it("pairs only depth-aware ok quotes at 20M in the same hour, takes medians over those hours, and a below-1d term is no premium", () => {
    const quotes: Quote[] = [];
    for (const h of hoursOf(1, 14)) quotes.push(term(h, "a", "1d", h <= 7 ? 50 : 52), term(h, "a", "7d", 55));
    // Not paired: a no-depth 7d, a depth-unknown 1d, a 7d in an hour without a 1d.
    quotes.push(term(15, "a", "1d", 50), term(15, "a", "7d", 200, { status: "no-depth", depth: 1_000_000 }));
    quotes.push(term(16, "a", "1d", 10, { status: "depth-unknown", depth: null }), term(16, "a", "7d", 200));
    quotes.push(term(17, "a", "7d", 200));
    for (const h of hoursOf(1, 12)) quotes.push(term(h, "b", "1d", 50), term(h, "b", "14d", 45));
    expect(venueTermPremiums(quotes)).toMatchObject({
      exists: false,
      venues: [
        { venue: "a", terms: { "7d": { pairedHours: 14, d1PerDay: 51, termPerDay: 55, premium: 0.0784, exists: false } } },
        { venue: "b", terms: { "14d": { pairedHours: 12, d1PerDay: 50, termPerDay: 45, premium: -0.1, exists: false } } },
      ],
      venuesWithoutTerm: [],
    });
    expect(venueTermPremiums([term(1, "c", "7d", 99)])).toMatchObject({ exists: false, venues: [], venuesWithoutTerm: [] });
  });
});

describe("parseRangeArgs for the band", () => {
  it("a from alone covers 24 hours", () => {
    expect(parseRangeArgs("1000", undefined, 24)).toEqual({ from: 1000, to: 1023 });
  });
});

describe("databaseEnv", () => {
  it("needs only DATABASE_URL, trimmed", () => {
    expect(databaseEnv({ DATABASE_URL: " postgres://x/y " })).toEqual({ databaseUrl: "postgres://x/y" });
    expect(() => databaseEnv({})).toThrow(expect.objectContaining({ name: "ConfigError", message: "DATABASE_URL is required" }));
  });
});

describe("verify-band without a database", () => {
  it("exits 2 naming DATABASE_URL, and for a bad hour argument", () => {
    const r = run([], {});
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).toBe("ConfigError: DATABASE_URL is required");
    expect(run(["abc"], { DATABASE_URL: "postgres://nobody@localhost:1/none_test" }).status).toBe(2);
  });
});

const H0 = 700_000;

describe.skipIf(!url)("the band fact over stored quotes", () => {
  let sql: Sql;
  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!);
  });
  beforeEach(async () => {
    await sql`truncate quotes`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  /** `n` hours from `from`: net 35.4; a dealer quote 41 (above) in hours where `above(h)`, else 38; TronSave terms at 20M. */
  async function seed(from: number, n: number, above: (h: number) => boolean) {
    const rows: Quote[] = [];
    for (let h = from; h < from + n; h++) {
      rows.push(net(h, 35.4), q(h, "tronsave", above(h) ? 41 : 38), q(h, "netts", 50), q(h, "getblock", 30, { status: "depth-unknown", depth: null }));
      rows.push(term(h, "tronsave", "1d", 78), term(h, "tronsave", "7d", 99), term(h, "tronsave", "14d", 99), term(h, "justlend", "1d", 44.2, { depth: null, status: "depth-unknown" }));
    }
    await insertQuotes(sql, rows);
  }

  it("defaults to the latest 24 hours with a justlend-net row; 12 hours >= 5 sun above passes", async () => {
    await seed(H0, 30, (h) => h % 2 === 0);
    // A newer hour with dealer quotes but no justlend-net row is outside the window.
    await insertQuotes(sql, [q(H0 + 40, "tronsave", 41)]);
    expect(await defaultBandWindow(sql)).toEqual({ from: H0 + 6, to: H0 + 29 });
    const f = await bandFact(sql, null, new Date((H0 + 30) * 3_600_000 + 60_000));
    expect(f).toMatchObject({ fact: "band", from: H0 + 6, to: H0 + 29, spanHours: 24, hoursSinceTo: 1, stale: false, pass: true, hoursAbove: 12, hoursObserved: 24, complete: true });
    expect(f.hours).toHaveLength(24);
    expect(f.hours[0]).toEqual({ hour: H0 + 6, cheapestSun: 41, cheapestVenue: "tronsave", justlendNetSun: 35.4, above: true });
    expect(f.hours[1]).toEqual({ hour: H0 + 7, cheapestSun: 38, cheapestVenue: "tronsave", justlendNetSun: 35.4, above: false });
    expect(f.termPremium).toMatchObject({ exists: true, venues: [{ venue: "tronsave", terms: { "7d": { pairedHours: 24, d1PerDay: 78, termPerDay: 99, premium: 0.2692 } } }], venuesWithoutTerm: ["justlend"] });
  });

  it("11 hours above fails; an explicit range is honoured; an hour with no depth-aware quote is a null row, not above", async () => {
    await seed(H0, 24, (h) => h < H0 + 11);
    await sql`delete from quotes where hour = ${H0 + 23} and venue <> 'justlend-net'`;
    const f = await bandFact(sql, { from: H0, to: H0 + 23 }, new Date((H0 + 30) * 3_600_000));
    expect(f).toMatchObject({ from: H0, to: H0 + 23, hoursSinceTo: 7, stale: true, pass: false, hoursAbove: 11, hoursObserved: 24, complete: true });
    expect(f.hours.at(-1)).toEqual({ hour: H0 + 23, cheapestSun: null, cheapestVenue: null, justlendNetSun: 35.4, above: false });
    const part = await bandFact(sql, parseRangeArgs(String(H0 + 12), undefined, 24), new Date((H0 + 30) * 3_600_000));
    // spanHours counts the hours judged (H0 + 12 to H0 + 23), not the requested range.
    expect(part).toMatchObject({ from: H0 + 12, to: H0 + 35, spanHours: 12, hoursObserved: 12, complete: false, pass: false });
  });

  it("gaps in the net series: 24 net hours spread over 30 are judged, but the window spans more than 24 hours so it is not complete", async () => {
    await seed(H0, 30, () => true);
    await sql`delete from quotes where venue = 'justlend-net' and hour in (${H0 + 10}, ${H0 + 11}, ${H0 + 12}, ${H0 + 13}, ${H0 + 14}, ${H0 + 15})`;
    expect(await defaultBandWindow(sql)).toEqual({ from: H0, to: H0 + 29 });
    expect(await bandFact(sql, null)).toMatchObject({ from: H0, to: H0 + 29, spanHours: 30, hoursObserved: 24, hoursAbove: 24, pass: true, complete: false });
  });

  it("an explicit range wider than 24 hours whose latest 24 net hours are all present is complete: the span is of the hours judged", async () => {
    await seed(H0, 30, () => true);
    const f = await bandFact(sql, { from: H0, to: H0 + 29 });
    expect(f).toMatchObject({ from: H0, to: H0 + 29, spanHours: 24, hoursObserved: 24, hoursAbove: 24, pass: true, complete: true });
    expect(f.hours[0]!.hour).toBe(H0 + 6);
    // With a gap inside the latest 24 net hours, the judged hours span more than 24: not complete.
    await sql`delete from quotes where venue = 'justlend-net' and hour = ${H0 + 20}`;
    expect(await bandFact(sql, { from: H0, to: H0 + 29 })).toMatchObject({ spanHours: 25, hoursObserved: 24, complete: false });
  });

  it("the default window orders hours numerically, not as text", async () => {
    // As text, "999999" sorts after "1000000"; as numbers it is older.
    await insertQuotes(sql, [net(999_999, 35), net(1_000_000, 35), q(1_000_000, "tronsave", 41)]);
    expect(await defaultBandWindow(sql)).toEqual({ from: 999_999, to: 1_000_000 });
    await insertQuotes(sql, Array.from({ length: 24 }, (_, i) => net(1_000_001 + i, 35)));
    expect(await defaultBandWindow(sql)).toEqual({ from: 1_000_001, to: 1_000_024 });
  });

  it("no justlend-net rows: no window, nothing observed, not a pass", async () => {
    await insertQuotes(sql, [q(H0, "tronsave", 41)]);
    expect(await bandFact(sql, null)).toMatchObject({ from: null, to: null, spanHours: null, hoursSinceTo: null, stale: false, pass: false, hoursAbove: 0, hoursObserved: 0, complete: false, hours: [], termPremium: { exists: false, venues: [] } });
  });

  it("the script prints exactly one JSON line on stdout, the same as the fact, with only DATABASE_URL", async () => {
    await seed(H0, 24, () => true);
    const r = run([String(H0), String(H0 + 23)], { DATABASE_URL: url! });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    const expected = JSON.parse(JSON.stringify(await bandFact(sql, { from: H0, to: H0 + 23 })));
    expect({ ...out, hoursSinceTo: 0, stale: false }).toEqual({ ...expected, hoursSinceTo: 0, stale: false });
    expect(out).toMatchObject({ fact: "band", pass: true, hoursAbove: 24 });
    const d = run([], { DATABASE_URL: url! });
    expect(d.status).toBe(0);
    expect(JSON.parse(d.stdout)).toMatchObject({ from: H0, to: H0 + 23, pass: true });
  });
});
