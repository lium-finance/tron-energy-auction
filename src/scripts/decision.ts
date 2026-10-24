import { hourStart } from "../core/hour.js";
import { BAND_WINDOW_HOURS, TERM_PREMIUM } from "../core/pass.js";
import type { Print, PrintStatus } from "../core/types.js";
import { publicPrint } from "../index/publish.js";
import { redactConfiguredSecrets, redactSecrets } from "../index/redact.js";
import { MIN_PAIRED_HOURS, TERM_PREMIUM_CONDITION, type bandFact } from "./band.js";
import type { clearabilityFact } from "./clearability.js";
import { toCsv } from "./csv.js";
import { listSourceForRecord } from "./record-source.js";
import type { supplierFact, utilisationFact } from "./verify-facts.js";

/**
 * The decision record's formatting, as pure functions: export-decision queries the facts and prints, calls these, and writes
 * what they return (write-record.ts). Nothing here reads the database, the clock or the environment (redactFiles takes
 * the environment).
 */

export type SupplierFact = Awaited<ReturnType<typeof supplierFact>>;
export type UtilisationFact = Awaited<ReturnType<typeof utilisationFact>>;
export type BandFact = Awaited<ReturnType<typeof bandFact>>;
export type ClearabilityFact = ReturnType<typeof clearabilityFact>;

export interface DecisionFacts {
  supplier: SupplierFact;
  utilisation: UtilisationFact;
  band: BandFact;
  clearability: ClearabilityFact;
}

/** Unix hours, inclusive; null is an open bound (or, in a written range, no print to bound it). */
export interface PrintsRange {
  from: number | null;
  to: number | null;
}

/** The files written into `<out>/<YYYY-MM-DD>/`, and nothing else. */
export const DECISION_FILES = ["prints.csv", "band.csv", "facts.json", "decision.md"] as const;
export type DecisionFile = (typeof DECISION_FILES)[number];
/** The human-readable record; redactFiles treats one of its lines specially. */
export const RECORD_FILE: DecisionFile = "decision.md";

export const DECISION_LINE = "Decision: (auction, term desk or index only; written by hand with the buyer calls cited)";

const hourUtc = (hour: number): string => hourStart(hour).toISOString();

export const PRINT_COLUMNS = ["hour", "hour_utc", "status", "median_sun", "cheapest_sun", "dearest_sun", "live_quotes", "depth_aware_venues", "method_version", "printed_at"] as const;

/** One row per print with every scalar field of Print (src/core/types.ts). */
export function printsCsv(prints: readonly Print[]): string {
  return toCsv(
    PRINT_COLUMNS,
    prints.map((p) => ({
      hour: p.hour,
      hour_utc: hourUtc(p.hour),
      status: p.status,
      median_sun: p.median,
      cheapest_sun: p.cheapest,
      dearest_sun: p.dearest,
      live_quotes: p.liveCount,
      depth_aware_venues: p.depthAwareCount,
      method_version: p.methodVersion,
      printed_at: p.printedAt,
    })),
  );
}

export const BAND_COLUMNS = ["hour", "hour_utc", "net_sun", "cheapest_sun", "cheapest_venue", "above"] as const;

/** The band fact's judged hours, one row each. */
export function bandCsv(rows: BandFact["hours"]): string {
  return toCsv(
    BAND_COLUMNS,
    rows.map((h) => ({ hour: h.hour, hour_utc: hourUtc(h.hour), net_sun: h.justlendNetSun, cheapest_sun: h.cheapestSun, cheapest_venue: h.cheapestVenue, above: h.above })),
  );
}

/**
 * The prints in [from, to] (an open bound takes everything on that side, so no `to` runs through the latest print), and the
 * range they cover: a given bound as given, an open one as the first or last selected print's hour (null with none).
 */
export function selectPrints(prints: readonly Print[], want: PrintsRange): { prints: Print[]; range: PrintsRange } {
  const selected = prints.filter((p) => (want.from === null || p.hour >= want.from) && (want.to === null || p.hour <= want.to));
  return { prints: selected, range: { from: want.from ?? selected[0]?.hour ?? null, to: want.to ?? selected.at(-1)?.hour ?? null } };
}

// Markdown

const cell = (s: string): string => s.replace(/\r?\n|\r/g, " ").replace(/\|/g, "\\|");
const row = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;
const yesNo = (b: boolean): string => (b ? "yes" : "no");
const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** A fraction as a percentage with 1 decimal. */
const pct = (x: number): number => Math.round(x * 1000) / 10;

const orNa = (v: number | null): string => (v === null ? "n/a" : String(v));

/**
 * `<from>-<to>; stale <yes|no>; complete <yes|no|n/a>; <hours> h old`. `freshTo` is the hour the fact's age is measured
 * from (its window's end; for clearability, the stored hour its inputs were read for): with none, staleness is n/a.
 */
function windowCell(from: number | null, to: number | null, fresh: { freshTo: number | null; stale: boolean; hoursSinceTo: number | null }, complete: boolean | null): string {
  const span = from === null || to === null ? "none" : `${from}-${to}`;
  const stale = fresh.freshTo === null ? "n/a" : yesNo(fresh.stale);
  return `${span}; stale ${stale}; complete ${complete === null ? "n/a" : yesNo(complete)}; ${orNa(fresh.hoursSinceTo)} h old`;
}

/** `; <read> of <listed> wallets read`, and `; MARGINAL` when the result is within 2 % of a threshold. */
const walletsRead = (f: { wallets: number; walletsListed: number; marginal: boolean }): string => `; ${f.wallets} of ${f.walletsListed} wallets read${f.marginal ? "; MARGINAL" : ""}`;

type Term = "7d" | "14d";
const TERMS: readonly Term[] = ["7d", "14d"];

/**
 * A premium as a percentage: 1 decimal when it exists, 2 when it does not, so one just under the threshold reads as such
 * (termPremium reports those rounded down to 4 dp: 9.999 % is "9.99", never "10").
 */
const premiumPct = (premium: number, exists: boolean): string => (exists ? String(pct(premium)) : (premium * 100).toFixed(2));

const BELOW_MIN_HOURS = `below ${MIN_PAIRED_HOURS}-hour minimum`;
const BELOW_THRESHOLD = `below ${pct(TERM_PREMIUM)} %`;

/**
 * The term's best premium: the highest among venues whose premium exists for it; when none exists, the highest shown by
 * any venue, labelled with why it does not count (fewer than MIN_PAIRED_HOURS paired hours, or under TERM_PREMIUM).
 */
function bestPremium(band: BandFact, term: Term): string {
  type Shown = { venue: string; premium: number; pairedHours: number; exists: boolean };
  const all: Shown[] = band.termPremium.venues.flatMap((v) => {
    const c = v.terms[term];
    return c.premium === null ? [] : [{ venue: v.venue, premium: c.premium, pairedHours: c.pairedHours, exists: c.exists }];
  });
  const pool = all.some((x) => x.exists) ? all.filter((x) => x.exists) : all;
  const best = pool.reduce<Shown | null>((b, x) => (b === null || x.premium > b.premium ? x : b), null);
  if (!best) return `${term} none`;
  const why = best.exists ? "" : best.pairedHours < MIN_PAIRED_HOURS ? `, ${BELOW_MIN_HOURS}` : `, ${BELOW_THRESHOLD}`;
  return `${term} ${best.premium >= 0 ? "+" : ""}${premiumPct(best.premium, best.exists)} % (${best.venue}, ${best.pairedHours} paired hours${why})`;
}

function clearabilityResult(c: ClearabilityFact): string {
  const width = c.bandWidthSun === null ? null : `band ${c.bandWidthSun} sun`;
  const result = c.reason === null ? (width ?? "no band") : `not run: ${c.reason}${width ? ` (${width})` : ""}`;
  return c.hour === null ? result : `${result}, hour ${c.hour}`;
}

/** The band window `--band-from <hour>` asks for: the 24 hours from it, [from, from + 23], the first day of collection when the band sample is taken from it. */
export function bandWindowFrom(from: number): { from: number; to: number } {
  return { from, to: from + BAND_WINDOW_HOURS - 1 };
}

/** The decision.md line that says which band window the record used. */
export function bandWindowLine(bandFrom: number | null): string {
  if (bandFrom === null) return `Band window: the latest ${BAND_WINDOW_HOURS} stored hours with a JustLend net rate (the default; no --band-from).`;
  const w = bandWindowFrom(bandFrom);
  return `Band window: hours ${w.from} to ${w.to}, the first ${BAND_WINDOW_HOURS} hours from --band-from ${bandFrom}.`;
}

/** Options for the record that are not facts: `bandFrom` is --band-from's hour, null (the default) for the latest-24 window. */
export interface RecordOptions {
  bandFrom?: number | null;
}

/** The decision.md line that names the top-100 list; redactFiles treats it specially. */
export const LIST_LINE_PREFIX = "Utilisation list: ";

/**
 * The decision record: one row per fact (window, one number, pass, the fact's own pass condition), the term premium per venue,
 * the exported prints by status, the clearability note verbatim, and the Decision line left for a human to write.
 */
export function decisionRecordMarkdown(facts: DecisionFacts, prints: readonly Print[], range: PrintsRange, date: string, o: RecordOptions = {}): string {
  return [
    `# Decision record, ${date}`,
    "",
    "Written by `npm run export-decision`. Each fact uses its own default window, in unix hours (inclusive); the data behind it is in facts.json, band.csv and prints.csv beside this file.",
    "",
    ...factsSection(facts, o),
    ...termPremiumSection(facts.band),
    ...printsSection(prints, range),
    "## Clearability note",
    "",
    facts.clearability.note,
    "",
    DECISION_LINE,
    "",
  ].join("\n");
}

const tableRule = (columns: number): string => row(Array.from({ length: columns }, () => "---"));

/** The age fields of a fact whose window ends at `to`. */
const freshFrom = (f: { to: number | null; stale: boolean; hoursSinceTo: number | null }) => ({ freshTo: f.to, stale: f.stale, hoursSinceTo: f.hoursSinceTo });

/** One row per fact, then the band window and the top-100 list it used. */
function factsSection(facts: DecisionFacts, o: RecordOptions): string[] {
  const { supplier: s, utilisation: u, band: b, clearability: c } = facts;
  const idle = s.wallets === 0 ? "n/a (no reads)" : `${grouped(s.idleUnitsPerDay)} idle units/day`;
  const util = u.utilisation === null ? "n/a" : `${pct(u.utilisation)} %`;
  const share = u.delegatedOutShare === null ? "n/a" : `${pct(u.delegatedOutShare)} %`;
  // Clearability's age is that of the stored hour its inputs came from (none when they are all flags).
  const clearFresh = { freshTo: c.hour, stale: c.stale, hoursSinceTo: c.hoursSinceTo };
  return [
    "## Facts",
    "",
    row(["Fact", "Window", "Result", "Pass", "Condition"]),
    tableRule(5),
    row(["supplier", windowCell(s.from, s.to, freshFrom(s), s.complete), `${idle}${walletsRead(s)}`, yesNo(s.pass), s.passCondition]),
    row(["utilisation", windowCell(u.from, u.to, freshFrom(u), u.complete), `${util} (${u.framing}); delegatedOutShare ${share}${walletsRead(u)}`, yesNo(u.pass), u.passCondition]),
    row(["band", windowCell(b.from, b.to, freshFrom(b), b.complete), `${b.hoursAbove} of ${b.hoursObserved} hours above; judged span ${orNa(b.spanHours)} h`, yesNo(b.pass), b.passCondition]),
    row(["term premium", windowCell(b.from, b.to, freshFrom(b), null), TERMS.map((t) => bestPremium(b, t)).join("; "), yesNo(b.termPremium.exists), TERM_PREMIUM_CONDITION]),
    row(["clearability", windowCell(c.window?.from ?? null, c.window?.to ?? null, clearFresh, null), clearabilityResult(c), yesNo(c.pass), c.passCondition]),
    "",
    bandWindowLine(o.bandFrom ?? null),
    "",
    `${LIST_LINE_PREFIX}${listSourceForRecord(u.listSource)}; read at ${u.listReadAt}; ${pct(u.shareOfTotalEnergyWeight)} % of TotalEnergyWeight; how it is built: docs/verification/top100-source.md`,
    "",
  ];
}

/** Each venue's 7d and 14d premium over its own 1d price, and the venues that sell no longer term. */
function termPremiumSection(b: BandFact): string[] {
  const lines = ["## Term premium by venue", ""];
  if (b.termPremium.venues.length === 0) {
    lines.push("No venue priced 1d and a 7d or 14d term at 20,000,000 units in the band window.");
  } else {
    lines.push(row(["Venue", "7d premium", "7d paired hours", "14d premium", "14d paired hours", "Exists"]), tableRule(6));
    for (const v of b.termPremium.venues) {
      const p = (t: Term): string => {
        const { premium, exists } = v.terms[t];
        return premium === null ? "n/a" : `${premiumPct(premium, exists)} %`;
      };
      lines.push(row([v.venue, p("7d"), String(v.terms["7d"].pairedHours), p("14d"), String(v.terms["14d"].pairedHours), yesNo(v.exists)]));
    }
  }
  if (b.termPremium.venuesWithoutTerm.length > 0) lines.push("", `Venues with a 1d price and no 7d or 14d term: ${b.termPremium.venuesWithoutTerm.join(", ")}.`);
  lines.push("");
  return lines;
}

const PRINT_STATUSES: readonly PrintStatus[] = ["live", "thin", "no_index"];

/** How many exported prints had each status. */
function printsSection(prints: readonly Print[], range: PrintsRange): string[] {
  const span = range.from === null && range.to === null ? "no prints" : `hours ${range.from ?? "first"} to ${range.to ?? "latest"}`;
  return [
    "## Prints by status",
    "",
    `Exported prints: ${prints.length} (${span}).`,
    "",
    row(["Status", "Prints"]),
    tableRule(2),
    ...PRINT_STATUSES.map((status) => row([status, String(prints.filter((p) => p.status === status).length)])),
    "",
  ];
}

/** The UTC date of a moment, YYYY-MM-DD: the directory the record goes into. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The four files' contents, not yet redacted. facts.json is pretty-printed with 2 spaces. prints.csv holds the prints as the
 * feed publishes them (publicPrint): a no_index or thin row carries no price, so nothing in the record reads as an index that was not published.
 */
export function decisionFiles(facts: DecisionFacts, prints: readonly Print[], range: PrintsRange, now: Date, o: RecordOptions = {}): Record<DecisionFile, string> {
  return {
    "prints.csv": printsCsv(prints.map(publicPrint)),
    "band.csv": bandCsv(facts.band.hours),
    "facts.json": `${JSON.stringify({ generatedAt: now.toISOString(), printsRange: range, ...facts }, null, 2)}\n`,
    "decision.md": decisionRecordMarkdown(facts, prints, range, utcDate(now), o),
  };
}

/**
 * Every file through redactSecrets, with one exception: decision.md's utilisation list line, whose URLs listSourceForRecord
 * already cut (scheme and host; the path too for an allowlisted origin), gets only the configured-secret layer, so its paths stay readable.
 */
export function redactFiles(files: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const redact = (name: string, text: string): string => {
    if (name !== RECORD_FILE) return redactSecrets(text, env);
    // decision.md is redacted line by line, so only the list line itself escapes the URL layer.
    return text
      .split("\n")
      .map((line) => (line.startsWith(LIST_LINE_PREFIX) ? redactConfiguredSecrets(line, env) : redactSecrets(line, env)))
      .join("\n");
  };
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, redact(name, text)]));
}

/**
 * The wallet lists must never reach a written file: the fact functions return counts, and this checks it. Throws (exit 1)
 * naming the file, never the address.
 */
export function assertNoAddresses(files: Readonly<Record<string, string>>, addresses: readonly string[]): void {
  for (const [name, text] of Object.entries(files)) {
    if (addresses.some((a) => a !== "" && text.includes(a))) throw new Error(`refusing to write the record: ${name} contains a listed wallet address`);
  }
}
