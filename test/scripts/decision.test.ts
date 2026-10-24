import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { METHOD_VERSION, type Print, type Quote } from "../../src/core/types.js";
import { createDb, insertChain, insertPrint, insertQuotes, insertVerification, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { BAND_PASS_CONDITION, TERM_PREMIUM_CONDITION, bandFact, venueTermPremiums } from "../../src/scripts/band.js";
import { CLEARABILITY_NOTE, CLEARABILITY_PASS_CONDITION, clearabilityDefaults, clearabilityFact, resolveInputs, type Defaults } from "../../src/scripts/clearability.js";
import {
  DECISION_FILES,
  DECISION_LINE,
  assertNoAddresses,
  bandCsv,
  decisionRecordMarkdown,
  decisionFiles,
  printsCsv,
  redactFiles,
  selectPrints,
  utcDate,
  type BandFact,
  type DecisionFacts,
  type SupplierFact,
  type UtilisationFact,
} from "../../src/scripts/decision.js";
import { toCsv } from "../../src/scripts/csv.js";
import { parseExportArgs } from "../../src/scripts/export-args.js";
import { listSourceForRecord } from "../../src/scripts/record-source.js";
import { supplierFact, utilisationFact } from "../../src/scripts/verify-facts.js";
import { writeRecord } from "../../src/scripts/write-record.js";
import type { Wallets } from "../../src/index/wallet-list.js";
import { testDbUrl as url } from "../index/testdb.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(tsx, ["src/scripts/export-decision.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ENV_FILE: "/nonexistent/.env", ...env }, encoding: "utf8", timeout: 30_000 });

const NOW = new Date(Date.UTC(2026, 9, 28, 9, 30));
const print = (hour: number, over: Partial<Print> = {}): Print => ({ hour, median: 41.5, cheapest: 40, dearest: 44.25, liveCount: 3, depthAwareCount: 2, status: "live", methodVersion: METHOD_VERSION, printedAt: new Date(hour * 3_600_000 + 300_000), ...over });

describe("toCsv", () => {
  it("quotes a field with a comma, quote, CR or LF, doubles inner quotes, leaves null and undefined empty, writes a Date as ISO", () => {
    const csv = toCsv(["a", "b", "c", "d", "e", "f", "g"], [{ a: "x,y", b: 'say "hi"', c: "two\nlines", d: null, e: undefined, f: new Date(0), g: "cr\rhere" }]);
    expect(csv).toBe('a,b,c,d,e,f,g\r\n"x,y","say ""hi""","two\nlines",,,1970-01-01T00:00:00.000Z,"cr\rhere"\r\n');
  });
  it("writes numbers and booleans plainly, a missing key as empty, and keeps the header with zero rows", () => {
    expect(toCsv(["n", "b", "m"], [{ n: 41.5, b: false }])).toBe("n,b,m\r\n41.5,false,\r\n");
    expect(toCsv(["hour", "status"], [])).toBe("hour,status\r\n");
  });
  it("prints.csv carries every scalar field of a print; band.csv one row per judged hour", () => {
    expect(printsCsv([])).toBe("hour,hour_utc,status,median_sun,cheapest_sun,dearest_sun,live_quotes,depth_aware_venues,method_version,printed_at\r\n");
    const lines = printsCsv([print(500_000), print(500_001, { status: "no_index", median: null, cheapest: null, dearest: null, liveCount: 0, depthAwareCount: 0 })]).split("\r\n");
    expect(lines[1]).toBe(`500000,2027-01-15T08:00:00.000Z,live,41.5,40,44.25,3,2,${METHOD_VERSION},2027-01-15T08:05:00.000Z`);
    expect(lines[2]).toBe(`500001,2027-01-15T09:00:00.000Z,no_index,,,,0,0,${METHOD_VERSION},2027-01-15T09:05:00.000Z`);
    expect(bandCsv([{ hour: 500_000, cheapestSun: 41, cheapestVenue: "tronsave", justlendNetSun: 35.4, above: true }, { hour: 500_001, cheapestSun: null, cheapestVenue: null, justlendNetSun: 35.4, above: false }])).toBe(
      "hour,hour_utc,net_sun,cheapest_sun,cheapest_venue,above\r\n500000,2027-01-15T08:00:00.000Z,35.4,41,tronsave,true\r\n500001,2027-01-15T09:00:00.000Z,35.4,,,false\r\n",
    );
  });
});

describe("selectPrints", () => {
  const all = [print(10), print(11), print(12), print(13)];
  it("keeps prints in [from, to]; a missing bound is open; the range reports the bounds actually covered", () => {
    expect(selectPrints(all, { from: null, to: null })).toEqual({ prints: all, range: { from: 10, to: 13 } });
    expect(selectPrints(all, { from: 11, to: null })).toEqual({ prints: all.slice(1), range: { from: 11, to: 13 } });
    expect(selectPrints(all, { from: 11, to: 12 })).toEqual({ prints: all.slice(1, 3), range: { from: 11, to: 12 } });
    expect(selectPrints([], { from: null, to: null })).toEqual({ prints: [], range: { from: null, to: null } });
    expect(selectPrints(all, { from: 20, to: null })).toEqual({ prints: [], range: { from: 20, to: null } });
  });
});

describe("parseExportArgs", () => {
  it("none, from only (through the latest print), from and to, --out in both forms", () => {
    expect(parseExportArgs([])).toEqual({ from: null, to: null, out: null, force: false, bandFrom: null });
    expect(parseExportArgs(["500000"])).toEqual({ from: 500_000, to: null, out: null, force: false, bandFrom: null });
    expect(parseExportArgs(["500000", "500100"])).toEqual({ from: 500_000, to: 500_100, out: null, force: false, bandFrom: null });
    expect(parseExportArgs(["500000", "--out", "/tmp/x"])).toEqual({ from: 500_000, to: null, out: "/tmp/x", force: false, bandFrom: null });
    expect(parseExportArgs(["--out=/tmp/y", "1", "2"])).toEqual({ from: 1, to: 2, out: "/tmp/y", force: false, bandFrom: null });
    expect(parseExportArgs(["--force", "1"])).toEqual({ from: 1, to: null, out: null, force: true, bandFrom: null });
  });
  it("--band-from <hour> (or --band-from=<hour>) sets the band's first hour, independent of the prints range", () => {
    expect(parseExportArgs(["--band-from", "500000"])).toMatchObject({ from: null, to: null, bandFrom: 500_000 });
    expect(parseExportArgs(["1", "--band-from=500000", "2"])).toMatchObject({ from: 1, to: 2, bandFrom: 500_000 });
    for (const bad of [["--band-from"], ["--band-from="], ["--band-from", "x"], ["--band-from", "1.5"], ["--band-from", "-1"], ["--band-from", "1", "--band-from", "2"], ["--band-from", "1234567890"]]) {
      expect(() => parseExportArgs(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ name: "ConfigError" }));
    }
  });
  it("a ConfigError for a bad integer, a to before from, a third hour, an unknown flag, a missing, empty or repeated --out, and a repeated or valued --force", () => {
    for (const bad of [["-1"], ["1.5"], ["1e3"], ["abc"], [""], ["0x10"], ["1", "x"], ["10", "9"], ["1", "2", "3"], ["--from", "1"], ["-o", "x"], ["--out"], ["--out="], ["--out", ""], ["--out", "a", "--out", "b"], ["1234567890"], ["--force", "--force"], ["--force=yes"]]) {
      expect(() => parseExportArgs(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ name: "ConfigError" }));
    }
  });
});

const addr = (c: string): string => `T${c}${"4".repeat(32)}`;

function supplier(over: Partial<SupplierFact> = {}): SupplierFact {
  return { fact: "supplier", from: 500_000, to: 500_026, hoursSinceTo: 1, stale: false, rows: 54, pass: true, idleUnitsPerDay: 230_123_456.7, complete: true, wallets: 2, walletsListed: 2, walletsMissing: 0, marginal: false, passCondition: "SUPPLIER-CONDITION", ...over };
}
function utilisation(over: Partial<UtilisationFact> = {}): UtilisationFact {
  return {
    fact: "utilisation", from: 500_000, to: 500_026, hoursSinceTo: 1, stale: false, rows: 27, listSource: "fixture", listReadAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.42,
    pass: false, framing: "neither", utilisation: 0.7712, complete: true, wallets: 1, walletsListed: 1, walletsMissing: 0, marginal: false, delegatedOutShare: 0.25, measures: "m", passCondition: "UTILISATION-CONDITION", ...over,
  };
}
function band(over: Partial<BandFact> = {}): BandFact {
  const quotes: Quote[] = [];
  const q = (hour: number, term: Quote["term"], sun: number): Quote => ({ hour, venue: "tronsave", size: 20_000_000, term, sunPerUnit: sun, depth: 20_000_000, readAt: new Date(0), source: "t", status: "ok", reason: null, payloadHash: null });
  for (let h = 500_003; h < 500_027; h++) quotes.push(q(h, "1d", 78), q(h, "7d", 99));
  return {
    fact: "band", from: 500_003, to: 500_026, spanHours: 24, hoursSinceTo: 1, stale: false, pass: true, hoursAbove: 14, hoursObserved: 24, complete: true,
    hours: [{ hour: 500_026, cheapestSun: 41, cheapestVenue: "tronsave", justlendNetSun: 35.4, above: true }], termPremium: venueTermPremiums(quotes), passCondition: BAND_PASS_CONDITION, ...over,
  };
}
const noDb: Defaults = { window: null, paired: null, latestNet: null, latestDealer: null, burn: { value: 100, source: "default", hour: null } };
const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
  supplier: supplier(),
  utilisation: utilisation(),
  band: band(),
  clearability: clearabilityFact(resolveInputs({ net: 35.4, dealer: 44, burn: 100 }, noDb), null, NOW),
  ...over,
});

describe("decisionRecordMarkdown", () => {
  const range = { from: 500_000, to: 500_026 };
  const prints = [print(500_000), print(500_001, { status: "thin" }), print(500_002, { status: "no_index", median: null }), print(500_003)];

  it("one row per fact with its window and age, one number, wallets read, pass and its own pass condition; the term table; print counts; the note; the Decision line last", () => {
    const md = decisionRecordMarkdown(facts(), prints, range, "2026-10-28");
    for (const c of ["SUPPLIER-CONDITION", "UTILISATION-CONDITION", BAND_PASS_CONDITION, TERM_PREMIUM_CONDITION, CLEARABILITY_PASS_CONDITION]) expect(md).toContain(c);
    expect(md).toContain("| Fact | Window | Result | Pass | Condition |");
    expect(md).toContain("| supplier | 500000-500026; stale no; complete yes; 1 h old | 230,123,457 idle units/day; 2 of 2 wallets read | yes |");
    expect(md).toContain("| utilisation | 500000-500026; stale no; complete yes; 1 h old | 77.1 % (neither); delegatedOutShare 25 %; 1 of 1 wallets read | no |");
    expect(md).toContain("| band | 500003-500026; stale no; complete yes; 1 h old | 14 of 24 hours above; judged span 24 h | yes |");
    expect(md).toContain("| term premium | 500003-500026; stale no; complete n/a; 1 h old | 7d +26.9 % (tronsave, 24 paired hours); 14d none | yes |");
    // Flags only: no stored hour, so no age and no staleness.
    expect(md).toContain("| clearability | none; stale n/a; complete n/a; n/a h old | band 8.6 sun | yes |");
    expect(md).toContain("| tronsave | 26.9 % | 24 | n/a | 0 | yes |");
    expect(md).toMatch(/\| live \| 2 \|/);
    expect(md).toMatch(/\| thin \| 1 \|/);
    expect(md).toMatch(/\| no_index \| 1 \|/);
    expect(md).toContain(CLEARABILITY_NOTE);
    expect(md.trimEnd().split("\n").at(-1)).toBe(DECISION_LINE);
    expect(DECISION_LINE).toBe("Decision: (auction, term desk or index only; written by hand with the buyer calls cited)");
  });

  it("the utilisation list line: source, read time, share of TotalEnergyWeight as a percent, and where the list is described", () => {
    const md = decisionRecordMarkdown(facts(), [], range, "2026-10-28");
    expect(md).toContain("Utilisation list: fixture; read at 2026-10-28T09:00:00Z; 42 % of TotalEnergyWeight; how it is built: docs/verification/top100-source.md");
    const withUrl = decisionRecordMarkdown(facts({ utilisation: utilisation({ listSource: "https://u:p@apilist.tronscanapi.com/api/account/list?sort=-power&key=k#x (top 100)\n+ https://api.trongrid.io/wallet/getaccount" }) }), [], range, "2026-10-28");
    expect(withUrl).toContain("Utilisation list: https://apilist.tronscanapi.com/api/account/list (top 100) + https://api.trongrid.io/wallet/getaccount; read at");
  });

  it("marginal results are flagged; a supplier with no reads says so; a hand-set age shows", () => {
    const md = decisionRecordMarkdown(
      facts({ supplier: supplier({ marginal: true, hoursSinceTo: 3, stale: true }), utilisation: utilisation({ marginal: true, wallets: 0, walletsMissing: 1 }) }),
      [],
      range,
      "2026-10-28",
    );
    expect(md).toContain("| supplier | 500000-500026; stale yes; complete yes; 3 h old | 230,123,457 idle units/day; 2 of 2 wallets read; MARGINAL | yes |");
    expect(md).toContain("77.1 % (neither); delegatedOutShare 25 %; 0 of 1 wallets read; MARGINAL | no |");
    const none = decisionRecordMarkdown(facts({ supplier: supplier({ from: null, to: null, hoursSinceTo: null, wallets: 0, idleUnitsPerDay: 0, pass: false, complete: false, walletsMissing: 2 }) }), [], range, "2026-10-28");
    expect(none).toContain("| supplier | none; stale n/a; complete no; n/a h old | n/a (no reads); 0 of 2 wallets read | no |");
  });

  it("the term premium row prefers a venue whose premium exists; otherwise it labels why the shown one does not", () => {
    const q = (hour: number, venue: string, term: Quote["term"], sun: number): Quote => ({ hour, venue, size: 20_000_000, term, sunPerUnit: sun, depth: 20_000_000, readAt: new Date(0), source: "t", status: "ok", reason: null, payloadHash: null });
    const quotes: Quote[] = [];
    // "big": +50 % over only 5 paired hours (no premium); "steady": +20 % over 12 (a premium).
    for (let h = 1; h <= 5; h++) quotes.push(q(h, "big", "1d", 40), q(h, "big", "7d", 60));
    for (let h = 1; h <= 12; h++) quotes.push(q(h, "steady", "1d", 50), q(h, "steady", "7d", 60));
    const both = decisionRecordMarkdown(facts({ band: band({ termPremium: venueTermPremiums(quotes) }) }), [], range, "2026-10-28");
    expect(both).toContain("| 7d +20 % (steady, 12 paired hours); 14d none | yes |");
    const onlyBig = decisionRecordMarkdown(facts({ band: band({ termPremium: venueTermPremiums(quotes.filter((x) => x.venue === "big")) }) }), [], range, "2026-10-28");
    expect(onlyBig).toContain("| 7d +50.00 % (big, 5 paired hours, below 12-hour minimum); 14d none | no |");
    const small: Quote[] = [];
    for (let h = 1; h <= 12; h++) small.push(q(h, "flat", "1d", 50), q(h, "flat", "7d", 52));
    expect(decisionRecordMarkdown(facts({ band: band({ termPremium: venueTermPremiums(small) }) }), [], range, "2026-10-28")).toContain("| 7d +4.00 % (flat, 12 paired hours, below 10 %); 14d none | no |");
  });

  it("a premium just under the threshold shows 2 decimals, never rounded up to the threshold beside \"below 10 %\"", () => {
    const q = (hour: number, venue: string, term: Quote["term"], sun: number): Quote => ({ hour, venue, size: 20_000_000, term, sunPerUnit: sun, depth: 20_000_000, readAt: new Date(0), source: "t", status: "ok", reason: null, payloadHash: null });
    const near = (d7: number): Quote[] => Array.from({ length: 12 }, (_, i) => [q(i + 1, "near", "1d", 100), q(i + 1, "near", "7d", d7)]).flat();
    const md = (d7: number) => decisionRecordMarkdown(facts({ band: band({ termPremium: venueTermPremiums(near(d7)) }) }), [], range, "2026-10-28");
    expect(md(109.95)).toContain("| 7d +9.95 % (near, 12 paired hours, below 10 %); 14d none | no |");
    expect(md(109.95)).toContain("| near | 9.95 % | 12 | n/a | 0 | no |");
    // 9.999 % is below the threshold: it is cut, not rounded, to 2 decimals.
    expect(md(109.999)).toContain("| 7d +9.99 % (near, 12 paired hours, below 10 %); 14d none | no |");
    expect(md(110)).toContain("| 7d +10 % (near, 12 paired hours); 14d none | yes |");
  });

  it("a clearability with no band is pass no with its reason and stored hour; a band with no hours shows no window, 0 of 0 and no span; utilisation with no number says so", () => {
    const d = { ...noDb, window: { from: 500_003, to: 500_026 }, paired: { hour: 500_026, net: { value: 46.99, source: "db" as const, hour: 500_026 }, dealer: { value: 45, source: "db" as const, hour: 500_026, venue: "tronsave" } } };
    const md = decisionRecordMarkdown(
      facts({
        clearability: clearabilityFact(resolveInputs({}, d), d.window, NOW),
        band: band({ from: null, to: null, spanHours: null, hoursSinceTo: null, pass: false, hoursAbove: 0, hoursObserved: 0, complete: false, hours: [], termPremium: venueTermPremiums([]) }),
        utilisation: utilisation({ utilisation: null, framing: "insufficient", delegatedOutShare: null, complete: false }),
      }),
      [],
      { from: null, to: null },
      "2026-10-28",
    );
    expect(md).toMatch(/\| clearability \| 500003-500026; stale no; complete n\/a; -?\d+ h old \| not run: no-band \(band -1.99 sun\), hour 500026 \| no \|/);
    expect(md).toContain("| band | none; stale n/a; complete no; n/a h old | 0 of 0 hours above; judged span n/a h | no |");
    expect(md).toContain("| term premium | none; stale n/a; complete n/a; n/a h old | 7d none; 14d none | no |");
    expect(md).toContain("| utilisation | 500000-500026; stale no; complete no; 1 h old | n/a (insufficient); delegatedOutShare n/a; 1 of 1 wallets read | no |");
    expect(md).toContain("No venue priced 1d and a 7d or 14d term");
    expect(md).toMatch(/\| live \| 0 \|/);
    expect(md).toContain(CLEARABILITY_NOTE);
    expect(md.trimEnd().split("\n").at(-1)).toBe(DECISION_LINE);
  });

  it("a passing clearability from a stored hour shows that hour", () => {
    const d = { ...noDb, window: { from: 500_003, to: 500_026 }, paired: { hour: 500_026, net: { value: 35.4, source: "db" as const, hour: 500_026 }, dealer: { value: 44, source: "db" as const, hour: 500_026, venue: "tronsave" } } };
    expect(decisionRecordMarkdown(facts({ clearability: clearabilityFact(resolveInputs({}, d), d.window, NOW) }), [], range, "2026-10-28")).toContain("| band 8.6 sun, hour 500026 | yes |");
  });

  it("a pipe or newline inside a cell cannot break the table", () => {
    const md = decisionRecordMarkdown(facts({ supplier: supplier({ passCondition: "a | b\nc" }) }), [], range, "2026-10-28");
    expect(md).toContain("a \\| b c");
  });
});

describe("listSourceForRecord", () => {
  it("keeps the path only for Tronscan's and TronGrid's https origins; any other URL is cut to scheme and host; never userinfo, query or fragment", () => {
    expect(listSourceForRecord("https://u:p@apilist.tronscanapi.com/api/account/list?sort=-power#f (top 100) + https://api.trongrid.io/wallet/getaccount.")).toBe(
      "https://apilist.tronscanapi.com/api/account/list (top 100) + https://api.trongrid.io/wallet/getaccount.",
    );
    expect(listSourceForRecord("https://u:p@a.example/x/y?k=1#f (top 100) + http://b.example:8080/z.")).toBe("https://a.example (top 100) + http://b.example:8080.");
    // A key in the path, as GetBlock puts it, is not kept.
    expect(listSourceForRecord("https://go.getblock.io/0123456789abcdef/wallet/getaccount")).toBe("https://go.getblock.io");
    // http is not on the allowlist, only https.
    expect(listSourceForRecord("http://api.trongrid.io/wallet/getaccount")).toBe("http://api.trongrid.io");
    expect(listSourceForRecord("fixture")).toBe("fixture");
    expect(listSourceForRecord("bad http://[nope/x")).toBe("bad [url]");
  });
  it("a non-special scheme keeps its scheme and host, never null/...", () => {
    expect(listSourceForRecord("see foo://host.example/secret/x?k=1")).toBe("see foo://host.example");
  });
  it("a schemeless host/path token gets the same treatment, with its query dropped; plain file paths are left alone", () => {
    expect(listSourceForRecord("apilist.tronscanapi.com/api/account/list?sort=-power&limit=100 (top 100)")).toBe("apilist.tronscanapi.com/api/account/list (top 100)");
    expect(listSourceForRecord("go.getblock.io/0123456789abcdef/wallet/getaccount?x=1, then api.trongrid.io/wallet/getaccount")).toBe("go.getblock.io, then api.trongrid.io/wallet/getaccount");
    expect(listSourceForRecord("built per docs/verification/top100-source.md")).toBe("built per docs/verification/top100-source.md");
  });
  it("a schemeless token drops a leading userinfo", () => {
    expect(listSourceForRecord("user:pw@go.getblock.io/0123456789abcdef/wallet/getaccount?x=1")).toBe("go.getblock.io");
    expect(listSourceForRecord("via u@apilist.tronscanapi.com/api/account/list?k=1")).toBe("via apilist.tronscanapi.com/api/account/list");
    // An address with no path or query is not a URL and is left alone.
    expect(listSourceForRecord("ask me@example.com")).toBe("ask me@example.com");
  });
  it("a schemeless host?query with no slash keeps only the host", () => {
    expect(listSourceForRecord("go.getblock.io?apikey=0123456789abcdef (top 100)")).toBe("go.getblock.io (top 100)");
    expect(listSourceForRecord("api.trongrid.io?k=1")).toBe("api.trongrid.io");
    expect(listSourceForRecord("https://go.getblock.io?apikey=0123456789abcdef")).toBe("https://go.getblock.io");
  });
  it("an IPv4 host, with or without a scheme, is cut to host and port", () => {
    expect(listSourceForRecord("10.0.0.5:8545/0123456789abcdef/wallet?y=1")).toBe("10.0.0.5:8545");
    expect(listSourceForRecord("u@10.0.0.5/key?y=1")).toBe("10.0.0.5");
    expect(listSourceForRecord("https://10.0.0.5/key")).toBe("https://10.0.0.5");
  });
});

describe("decisionFiles, redactFiles and assertNoAddresses", () => {
  it("the four files, facts.json pretty-printed with generatedAt and printsRange", () => {
    const f = facts();
    const files = decisionFiles(f, [print(500_000)], { from: 500_000, to: 500_000 }, NOW);
    expect(Object.keys(files).sort()).toEqual([...DECISION_FILES].sort());
    const json = files["facts.json"]!;
    expect(json).toContain('\n  "generatedAt": "2026-10-28T09:30:00.000Z"');
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify({ generatedAt: NOW, printsRange: { from: 500_000, to: 500_000 }, ...f })));
    expect(utcDate(NOW)).toBe("2026-10-28");
    expect(utcDate(new Date(Date.UTC(2026, 9, 28, 23, 59)))).toBe("2026-10-28");
  });
  it("prints.csv publishes what the feed publishes: a no_index or thin row carries no price, even when the stored row has one", () => {
    const stray = print(500_001, { status: "no_index", median: null, cheapest: 60.5, dearest: 61, liveCount: 1, depthAwareCount: 1 });
    const thin = print(500_002, { status: "thin", median: 52.5, cheapest: 50.25, dearest: 54.75, liveCount: 2, depthAwareCount: 3 });
    const csv = decisionFiles(facts(), [print(500_000), stray, thin], { from: 500_000, to: 500_002 }, NOW)["prints.csv"]!;
    const lines = csv.split("\r\n");
    expect(lines[0]).not.toMatch(/raw_/);
    expect(lines[1]).toBe(`500000,2027-01-15T08:00:00.000Z,live,41.5,40,44.25,3,2,${METHOD_VERSION},2027-01-15T08:05:00.000Z`);
    expect(lines[2]).toBe(`500001,2027-01-15T09:00:00.000Z,no_index,,,,1,1,${METHOD_VERSION},2027-01-15T09:05:00.000Z`);
    expect(lines[3]).toBe(`500002,2027-01-15T10:00:00.000Z,thin,,,,2,3,${METHOD_VERSION},2027-01-15T10:05:00.000Z`);
    for (const v of ["60.5", "52.5", "50.25", "54.75"]) expect(csv).not.toContain(v);
  });
  it("decision.md states which band window was used: the latest 24 by default, the first 24 from --band-from when given", () => {
    const latest = decisionFiles(facts(), [], { from: null, to: null }, NOW)["decision.md"]!;
    expect(latest).toContain("Band window: the latest 24 stored hours with a JustLend net rate (the default; no --band-from).");
    const first = decisionFiles(facts(), [], { from: null, to: null }, NOW, { bandFrom: 500_003 })["decision.md"]!;
    expect(first).toContain("Band window: hours 500003 to 500026, the first 24 hours from --band-from 500003.");
  });
  it("redactFiles removes a secret-named variable's value from every file", () => {
    const out = redactFiles({ "a.md": "key 0123456789abcdef here", "b.csv": "x" }, { NILE_PRIVATE_KEY: "0123456789abcdef" });
    expect(out).toEqual({ "a.md": "key [redacted] here", "b.csv": "x" });
  });
  it("redactFiles keeps the path in decision.md's utilisation list line (secrets still removed) and reduces URLs everywhere else", () => {
    const env = { TRONSCAN_API_KEY: "s3cr3tpathpart" };
    const md = "Utilisation list: https://a.example/api/list (top 100) + https://a.example/s3cr3tpathpart/x; read at t\nother https://a.example/api/list\n";
    expect(redactFiles({ "decision.md": md, "facts.json": '{"s":"https://a.example/api/list"}' }, env)).toEqual({
      "decision.md": "Utilisation list: https://a.example/api/list (top 100) + https://a.example/[redacted]/x; read at t\nother https://a.example/[redacted]\n",
      "facts.json": '{"s":"https://a.example/[redacted]"}',
    });
  });
  it("assertNoAddresses throws naming the file, never the address", () => {
    const a = addr("a");
    expect(() => assertNoAddresses({ "ok.md": "nothing" }, [a])).not.toThrow();
    let message = "";
    try {
      assertNoAddresses({ "ok.md": "nothing", "facts.json": `{"x":"${a}"}` }, [a]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("facts.json");
    expect(message).not.toContain(a);
  });
});

describe("writeRecord", () => {
  const files = { "a.csv": "a\r\n", "b.md": "# b\n" };
  const AT = new Date(Date.UTC(2026, 9, 28, 9, 30, 5, 123));
  it("writes the files into <out>/<date>/ and nothing else, creating <out>", () => {
    const out = join(mkdtempSync(join(tmpdir(), "record-")), "nested", "decisions");
    const r = writeRecord(out, "2026-10-28", files, { force: false });
    expect(r).toEqual({ dir: join(out, "2026-10-28"), replaced: null });
    expect(readdirSync(out)).toEqual(["2026-10-28"]);
    expect(readdirSync(r.dir).sort()).toEqual(["a.csv", "b.md"]);
    expect(readFileSync(join(r.dir, "a.csv"), "utf8")).toBe("a\r\n");
  });
  it("refuses to replace an existing record unless forced; forced, the old one is kept beside it as <date>.replaced-<UTC timestamp>", () => {
    const out = mkdtempSync(join(tmpdir(), "record-"));
    const { dir } = writeRecord(out, "2026-10-28", files, { force: false });
    writeFileSync(join(dir, "b.md"), "# b\nDecision: B, after the buyer calls\n");
    expect(() => writeRecord(out, "2026-10-28", { "a.csv": "new" }, { force: false })).toThrow(/already exists.*--force/);
    expect(readFileSync(join(dir, "b.md"), "utf8")).toContain("Decision: B");
    expect(readdirSync(out)).toEqual(["2026-10-28"]);
    const r = writeRecord(out, "2026-10-28", { "a.csv": "new" }, { force: true, now: AT });
    expect(r).toEqual({ dir, replaced: join(out, "2026-10-28.replaced-20261028T093005Z") });
    expect(readdirSync(out).sort()).toEqual(["2026-10-28", "2026-10-28.replaced-20261028T093005Z"]);
    expect(readdirSync(dir)).toEqual(["a.csv"]);
    expect(readFileSync(join(dir, "a.csv"), "utf8")).toBe("new");
    expect(readFileSync(join(r.replaced!, "b.md"), "utf8")).toContain("Decision: B");
    // A second forced run in the same second does not overwrite the first kept record.
    const again = writeRecord(out, "2026-10-28", { "a.csv": "newer" }, { force: true, now: AT });
    expect(again.replaced).toBe(join(out, "2026-10-28.replaced-20261028T093005Z-2"));
    expect(readFileSync(join(again.replaced!, "a.csv"), "utf8")).toBe("new");
    expect(readFileSync(join(r.replaced!, "b.md"), "utf8")).toContain("Decision: B");
  });
  it("a failed write leaves no partial date directory and no temporary one; a forced one that fails keeps the old record", () => {
    const out = mkdtempSync(join(tmpdir(), "record-"));
    // A name inside a missing subdirectory cannot be written.
    expect(() => writeRecord(out, "2026-10-28", { "a.csv": "a", "missing/b.md": "b" }, { force: false })).toThrow();
    expect(readdirSync(out)).toEqual([]);
    mkdirSync(join(out, "2026-10-28"));
    writeFileSync(join(out, "2026-10-28", "decision.md"), "old");
    expect(() => writeRecord(out, "2026-10-28", { "missing/b.md": "b" }, { force: true })).toThrow();
    expect(readdirSync(out)).toEqual(["2026-10-28"]);
    expect(readFileSync(join(out, "2026-10-28", "decision.md"), "utf8")).toBe("old");
  });
  it("a forced swap whose rename of the new record fails puts the old record back, and leaves nothing else", () => {
    const out = mkdtempSync(join(tmpdir(), "record-"));
    mkdirSync(join(out, "2026-10-28"));
    writeFileSync(join(out, "2026-10-28", "decision.md"), "old\nDecision: B\n");
    const calls: [string, string][] = [];
    const rename = (from: string, to: string): void => {
      calls.push([from, to]);
      if (from.includes(".tmp-")) throw new Error("injected rename failure");
      renameSync(from, to);
    };
    expect(() => writeRecord(out, "2026-10-28", { "decision.md": "new" }, { force: true, now: AT, rename })).toThrow("injected rename failure");
    // Moved aside, the new one refused, then moved back.
    const kept = join(out, "2026-10-28.replaced-20261028T093005Z");
    expect(calls.map(([from, to]) => [from.replace(out, "<out>").replace(/\.tmp-.*/, ".tmp-*"), to.replace(out, "<out>")])).toEqual([
      ["<out>/2026-10-28", "<out>/2026-10-28.replaced-20261028T093005Z"],
      ["<out>/.2026-10-28.tmp-*", "<out>/2026-10-28"],
      ["<out>/2026-10-28.replaced-20261028T093005Z", "<out>/2026-10-28"],
    ]);
    expect(existsSync(kept)).toBe(false);
    expect(readdirSync(out)).toEqual(["2026-10-28"]);
    expect(readFileSync(join(out, "2026-10-28", "decision.md"), "utf8")).toBe("old\nDecision: B\n");
  });
  it("when the rollback rename fails too, the error says where the old record is and keeps the first failure as its cause", () => {
    const out = mkdtempSync(join(tmpdir(), "record-"));
    mkdirSync(join(out, "2026-10-28"));
    writeFileSync(join(out, "2026-10-28", "decision.md"), "old\nDecision: B\n");
    const first = new Error("injected rename failure");
    const rename = (from: string, to: string): void => {
      if (from.includes(".tmp-")) throw first;
      if (from.includes(".replaced-")) throw new Error("injected rollback failure");
      renameSync(from, to);
    };
    let err: Error | undefined;
    try {
      writeRecord(out, "2026-10-28", { "decision.md": "new" }, { force: true, now: AT, rename });
    } catch (e) {
      err = e as Error;
    }
    const kept = join(out, "2026-10-28.replaced-20261028T093005Z");
    expect(err?.message).toContain(kept);
    expect(err?.message).toContain("injected rollback failure");
    expect(err?.cause).toBe(first);
    expect(readFileSync(join(kept, "decision.md"), "utf8")).toBe("old\nDecision: B\n");
    expect(readdirSync(out)).toEqual(["2026-10-28.replaced-20261028T093005Z"]);
  });
});

describe("export-decision without a database", () => {
  it("exit 2 for a bad argument before reading the environment, and naming DATABASE_URL or VERIFY_WALLETS_FILE", () => {
    const bad = run(["abc"]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr.trim()).toBe('ConfigError: from must be a unix hour; got "abc"');
    expect(run([]).stderr.trim()).toBe("ConfigError: DATABASE_URL is required");
    const w = run([], { DATABASE_URL: "postgres://nobody@localhost:1/none_test" });
    expect(w.status).toBe(2);
    expect(w.stderr.trim()).toBe("ConfigError: VERIFY_WALLETS_FILE is required");
  });
});

describe("docs/decisions", () => {
  it("is not gitignored: the decision record is meant to be committed", () => {
    for (const f of DECISION_FILES) {
      const r = spawnSync("git", ["check-ignore", "-q", `docs/decisions/2026-10-28/${f}`], { cwd: root });
      // check-ignore exits 1 when the path is not ignored (0 when it is, 128 on an error).
      expect(r.status, f).toBe(1);
    }
  });
  it("a temporary directory (a dot name) left by a crash is gitignored, so it cannot be committed; a kept replaced record is not", () => {
    for (const p of ["docs/decisions/.2026-10-28.tmp-Ab12Cd/decision.md", "docs/decisions/.2026-10-29.tmp-Zz9Yx8/prints.csv"]) {
      const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: root });
      expect(r.status, p).toBe(0);
    }
    const kept = spawnSync("git", ["check-ignore", "-q", "docs/decisions/2026-10-28.replaced-20261028T093005Z/decision.md"], { cwd: root });
    expect(kept.status).toBe(1);
  });
  it("its CSVs keep their CRLF line endings in git (.gitattributes: -text)", () => {
    const r = spawnSync("git", ["check-attr", "text", "docs/decisions/2026-10-28/prints.csv", "docs/decisions/2026-10-28/band.csv"], { cwd: root, encoding: "utf8" });
    expect(r.stdout.trim().split("\n")).toEqual(["docs/decisions/2026-10-28/prints.csv: text: unset", "docs/decisions/2026-10-28/band.csv: text: unset"]);
  });
});

const H0 = 720_000;
const S1 = addr("a");
const S2 = addr("b");
const TOP1 = addr("c");
const TOP2 = addr("d");

describe.skipIf(!url)("export-decision end to end", () => {
  let sql: Sql;
  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!);
  });
  beforeEach(async () => {
    await sql`truncate quotes, prints, chain, verification`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  async function seed() {
    const q = (hour: number, venue: string, sun: number, over: Partial<Quote> = {}): Quote => ({ hour, venue, size: 20_000_000, term: "1h", sunPerUnit: sun, depth: 20_000_000, readAt: new Date(hour * 3_600_000), source: "t", status: "ok", reason: null, payloadHash: null, ...over });
    const rows: Quote[] = [];
    for (let h = H0; h < H0 + 27; h++) {
      rows.push(q(h, "justlend-net", 35.4, { term: "1d", depth: null, status: "depth-unknown" }), q(h, "tronsave", h % 2 === 0 ? 41 : 38));
      rows.push(q(h, "tronsave", 78, { term: "1d" }), q(h, "tronsave", 99, { term: "7d" }));
      await insertPrint(sql, print(h, h === H0 ? { status: "thin" } : {}));
    }
    await insertQuotes(sql, rows);
    await insertChain(sql, { hour: H0 + 26, energyFeeSun: 100, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() });
    for (const [wallet, limit, used] of [[S1, 180_000_000, 30_000_000], [S2, 100_000_000, 20_000_000], [TOP1, 100_000_000, 90_000_000], [TOP2, 50_000_000, 45_000_000]] as const) {
      for (let h = H0; h < H0 + 27; h++) await insertVerification(sql, { hour: h, wallet, energyLimit: limit, energyUsed: used, readAt: new Date(), source: "fixture" });
    }
  }

  it("writes the four files into <out>/<date>/ only, matching the fact functions, with no wallet address in any file or on stdout", async () => {
    await seed();
    const w: Wallets = { supplier: [S1, S2], top100: { source: "fixture", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.42, wallets: [TOP1, TOP2], stakeTotals: null } };
    const walletsFile = join(mkdtempSync(join(tmpdir(), "wallets-")), "wallets.json");
    writeFileSync(walletsFile, JSON.stringify({ supplier: w.supplier, top100: { ...w.top100, stakeTotals: undefined } }));
    const out = mkdtempSync(join(tmpdir(), "decisions-"));

    const r = run([String(H0 + 1), "--out", out], { DATABASE_URL: url!, VERIFY_WALLETS_FILE: walletsFile });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const date = utcDate(new Date());
    const dir = join(out, date);
    expect(r.stdout).toBe(`${dir}\n`);

    // Nothing outside <out>/<date>/, and exactly the four files inside it.
    expect(readdirSync(out)).toEqual([date]);
    expect(readdirSync(dir).sort()).toEqual([...DECISION_FILES].sort());
    const files = Object.fromEntries(DECISION_FILES.map((f) => [f, readFileSync(join(dir, f), "utf8")]));

    // Privacy: no supplier or top-100 address anywhere written or printed.
    for (const a of [S1, S2, TOP1, TOP2]) {
      for (const [name, text] of Object.entries(files)) expect(text.includes(a), `${name} contains a wallet address`).toBe(false);
      expect(r.stdout.includes(a)).toBe(false);
    }

    const written = JSON.parse(files["facts.json"]!) as Record<string, Record<string, unknown>>;
    const fresh = (o: unknown) => ({ ...(o as Record<string, unknown>), hoursSinceTo: 0, stale: false });
    const b = await bandFact(sql, null);
    const d = await clearabilityDefaults(sql);
    const c = clearabilityFact(resolveInputs({}, d), d.window);
    expect(fresh(written.band)).toEqual(fresh(JSON.parse(JSON.stringify(b))));
    expect(fresh(written.clearability)).toEqual(fresh(JSON.parse(JSON.stringify(c))));
    expect(fresh(written.supplier)).toEqual(fresh(await supplierFact(sql, w, null)));
    expect(fresh(written.utilisation)).toEqual(fresh(await utilisationFact(sql, w, null)));
    expect(written.printsRange).toEqual({ from: H0 + 1, to: H0 + 26 });
    expect(written.clearability).toMatchObject({ pass: true });

    // prints.csv: the header and the 26 prints from H0 + 1 through the latest; band.csv: the 24 judged hours.
    expect(files["prints.csv"]!.trimEnd().split("\r\n")).toHaveLength(27);
    expect(files["band.csv"]!.trimEnd().split("\r\n")).toHaveLength(25);
    expect(files["decision.md"]).toMatch(/\| live \| 26 \|/);
    expect(files["decision.md"]).toMatch(/\| thin \| 0 \|/);

    // A hand-written Decision line, then a re-run: refused (exit 1), the record untouched.
    const decided = `${files["decision.md"]!.replace(DECISION_LINE, "Decision: index only (buyer calls 1 and 2)")}`;
    writeFileSync(join(dir, "decision.md"), decided);
    const again = run(["--out", out], { DATABASE_URL: url!, VERIFY_WALLETS_FILE: walletsFile });
    expect(again.status).toBe(1);
    expect(again.stdout).toBe("");
    expect(again.stderr).toMatch(/already exists.*--force/);
    expect(readFileSync(join(dir, "decision.md"), "utf8")).toBe(decided);
    expect(readdirSync(out)).toEqual([date]);

    // With --force and every print: the directory is replaced, and the old one, with its Decision line, kept beside it.
    const all = run(["--out", out, "--force"], { DATABASE_URL: url!, VERIFY_WALLETS_FILE: walletsFile });
    expect(all.stderr).toBe("");
    expect(all.status).toBe(0);
    const entries = readdirSync(out).sort();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe(date);
    expect(entries[1]).toMatch(new RegExp(`^${date}\\.replaced-\\d{8}T\\d{6}Z$`));
    expect(all.stdout).toBe(`${dir}\nthe replaced record is kept at ${join(out, entries[1]!)}\n`);
    expect(readFileSync(join(out, entries[1]!, "decision.md"), "utf8")).toBe(decided);
    expect(readdirSync(dir).sort()).toEqual([...DECISION_FILES].sort());
    expect(readFileSync(join(dir, "decision.md"), "utf8")).toMatch(/\| thin \| 1 \|/);
    expect(existsSync(join(dir, "prints.csv"))).toBe(true);
  });

  it("--band-from judges the band over [from, from + 23] instead of the latest 24 hours, and decision.md says so", async () => {
    await seed();
    const walletsFile = join(mkdtempSync(join(tmpdir(), "wallets-")), "wallets.json");
    writeFileSync(walletsFile, JSON.stringify({ supplier: [S1, S2], top100: { source: "fixture", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.42, wallets: [TOP1, TOP2] } }));
    const out = mkdtempSync(join(tmpdir(), "decisions-"));
    const r = run(["--band-from", String(H0), "--out", out], { DATABASE_URL: url!, VERIFY_WALLETS_FILE: walletsFile });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const dir = join(out, utcDate(new Date()));
    const written = JSON.parse(readFileSync(join(dir, "facts.json"), "utf8")) as { band: { from: number; to: number } };
    expect(written.band).toMatchObject({ from: H0, to: H0 + 23 });
    const b = await bandFact(sql, { from: H0, to: H0 + 23 });
    expect({ ...written.band, hoursSinceTo: 0, stale: false }).toEqual({ ...JSON.parse(JSON.stringify(b)), hoursSinceTo: 0, stale: false });
    expect(readFileSync(join(dir, "decision.md"), "utf8")).toContain(`Band window: hours ${H0} to ${H0 + 23}, the first 24 hours from --band-from ${H0}.`);
    expect(readFileSync(join(dir, "band.csv"), "utf8").trimEnd().split("\r\n")[1]).toMatch(new RegExp(`^${H0},`));
  });
});
