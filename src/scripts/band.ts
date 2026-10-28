import { BAND_WINDOW_HOURS, bandPass, termPremium, type BandHour } from "../core/pass.js";
import { isDepthAware } from "../core/print.js";
import { median, to4dp } from "../core/stats.js";
import { INSTRUMENT, type Quote, type Term } from "../core/types.js";
import { collectOnlyVenues } from "../index/config.js";
import { quotesBetween, type Sql } from "../index/db.js";
import { publishable } from "../index/gate.js";
import { freshness, type HourRange } from "./verify-facts.js";

/** The supplier's alternative: JustLend's daily rate net of its reserve (src/collectors/justlend.ts). */
export const NET_VENUE = "justlend-net";

const priced = (q: Pick<Quote, "sunPerUnit">): q is Pick<Quote, "sunPerUnit"> & { sunPerUnit: number } =>
  typeof q.sunPerUnit === "number" && Number.isFinite(q.sunPerUnit) && q.sunPerUnit > 0;

/** A quote that can fill the instrument at its price: depth-aware (print.ts's rule), status ok, a positive finite price. */
export function isDealerQuote(q: Quote): boolean {
  return isDepthAware(q) && q.status === "ok" && priced(q);
}

/** A justlend-net 1-day row with a price; it is stored with status depth-unknown (JustLend reports no depth), so status is not checked. */
export function isNetQuote(q: Quote): boolean {
  return q.venue === NET_VENUE && q.term === "1d" && priced(q);
}

export type BandRow = BandHour & { cheapestVenue: string | null };

/**
 * From stored quote rows, one row per hour that has a justlend-net rate: the cheapest dealer quote (isDealerQuote) that hour
 * against that hour's net rate, oldest hour first. An hour with no dealer quote has cheapestSun null (not above).
 */
export function assembleBandHours(quotes: readonly Quote[]): BandRow[] {
  const byHour = new Map<number, { cheapest: number | null; venue: string | null; net: number | null }>();
  for (const q of quotes) {
    const e = byHour.get(q.hour) ?? { cheapest: null, venue: null, net: null };
    if (isNetQuote(q)) e.net = q.sunPerUnit;
    else if (isDealerQuote(q) && (e.cheapest === null || (q.sunPerUnit as number) < e.cheapest)) {
      e.cheapest = q.sunPerUnit;
      e.venue = q.venue;
    }
    byHour.set(q.hour, e);
  }
  return [...byHour.entries()]
    .filter(([, e]) => e.net !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([hour, e]) => ({ hour, cheapestSun: e.cheapest, cheapestVenue: e.venue, justlendNetSun: e.net as number }));
}


/** A term quote that can fill the instrument at its price: 20M units, depth reported and covering 20M, status ok, a positive finite price. */
const isTermQuote = (q: Quote, term: Term): boolean =>
  q.term === term && q.size === INSTRUMENT.units && q.depth !== null && q.depth >= INSTRUMENT.units && q.status === "ok" && priced(q);

/** A 20M price for the term in any status, used only to tell which venues sell the term at all. */
const quotesTerm = (q: Quote, term: Term): boolean => q.term === term && q.size === INSTRUMENT.units && priced(q);

/** A term premium may exist only over at least this many hours where the venue priced both 1d and the term. */
export const MIN_PAIRED_HOURS = 12;

export interface TermComparison {
  /** Hours in which the venue has a depth-aware 20M quote for both 1d and this term. */
  pairedHours: number;
  /** Medians over the paired hours, sun per unit-day (4 dp); null with no paired hour. */
  d1PerDay: number | null;
  termPerDay: number | null;
  premium: number | null;
  /** termPremium's verdict, and at least MIN_PAIRED_HOURS paired hours. */
  exists: boolean;
}

export interface VenueTermPremium {
  venue: string;
  terms: { "7d": TermComparison; "14d": TermComparison };
  exists: boolean;
}

export const TERM_NOTE =
  "per venue, like for like at 20,000,000 units: each term is compared with the venue's own 1d price over the hours where both have a depth-aware ok quote (medians over those paired hours), and needs >= 12 paired hours; JustLend (justlend, justlend-net) posts only a 1-day rate and has no 7d or 14d price, so it is not compared, and justlend-net is the supplier's alternative, not a sold term";

function compare(d1: ReadonlyMap<number, number>, t: ReadonlyMap<number, number>): TermComparison {
  const paired = [...t.keys()].filter((h) => d1.has(h));
  if (paired.length === 0) return { pairedHours: 0, d1PerDay: null, termPerDay: null, premium: null, exists: false };
  const d1PerDay = median(paired.map((h) => d1.get(h)!)) as number;
  const termPerDay = median(paired.map((h) => t.get(h)!)) as number;
  const p = termPremium({ d1PerDay, d7PerDay: termPerDay, d14PerDay: null });
  return { pairedHours: paired.length, d1PerDay: to4dp(d1PerDay), termPerDay: to4dp(termPerDay), premium: p.premium, exists: p.exists && paired.length >= MIN_PAIRED_HOURS };
}

/**
 * The term premium per venue, never across venues and only over the same hours: for each venue (justlend-net excluded) that
 * prices 1d and 7d or 14d at the instrument's size, each term is set against the venue's 1d price over the hours where both
 * have a depth-aware ok quote, as the medians of each over those hours, put through termPremium. A term's premium exists
 * only with at least 12 paired hours. `exists` when any venue's term does. Venues pricing 1d and no 7d/14d are listed in
 * `venuesWithoutTerm`.
 */
export function venueTermPremiums(quotes: readonly Quote[]): { exists: boolean; minPairedHours: number; venues: VenueTermPremium[]; venuesWithoutTerm: string[]; note: string } {
  const venues = [...new Set(quotes.filter((q) => q.venue !== NET_VENUE).map((q) => q.venue))].sort();
  const out: VenueTermPremium[] = [];
  const withoutTerm: string[] = [];
  for (const venue of venues) {
    const mine = quotes.filter((q) => q.venue === venue);
    const sells = (term: Term): boolean => mine.some((q) => quotesTerm(q, term));
    if (!sells("1d")) continue;
    if (!sells("7d") && !sells("14d")) {
      withoutTerm.push(venue);
      continue;
    }
    const byHour = (term: Term): Map<number, number> => new Map(mine.filter((q) => isTermQuote(q, term)).map((q) => [q.hour, q.sunPerUnit as number]));
    const d1 = byHour("1d");
    const terms = { "7d": compare(d1, byHour("7d")), "14d": compare(d1, byHour("14d")) };
    out.push({ venue, terms, exists: terms["7d"].exists || terms["14d"].exists });
  }
  return { exists: out.some((v) => v.exists), minPairedHours: MIN_PAIRED_HOURS, venues: out, venuesWithoutTerm: withoutTerm, note: TERM_NOTE };
}

/** The latest 24 stored hours with a priced justlend-net row, as a range (from the oldest to the newest of them); null when there is none. */
export async function defaultBandWindow(sql: Sql): Promise<HourRange | null> {
  // Ordered by the bigint column itself (postgres.js returns it as a string, read with Number below).
  const rows = await sql<{ hour: string }[]>`
    select distinct hour from quotes
    where venue = ${NET_VENUE} and term = '1d' and sun_per_unit > 0
    order by hour desc limit ${BAND_WINDOW_HOURS}`;
  if (rows.length === 0) return null;
  const hours = rows.map((r) => Number(r.hour));
  return { from: Math.min(...hours), to: Math.max(...hours) };
}

/** The term premium's own condition; the band fact's passCondition ends with it. */
export const TERM_PREMIUM_CONDITION =
  "a venue's 7d or 14d price per unit-day >= 10 % above its own 1d price at 20,000,000 units, medians over >= 12 hours where it quoted both";

export const BAND_PASS_CONDITION = `in >= 12 of the latest 24 hours, the cheapest ok quote for 20,000,000 units for 1 hour with depth >= 20,000,000 is >= 5 sun above that hour's JustLend daily rate net of its reserve (sun per unit-day); term premium: ${TERM_PREMIUM_CONDITION}`;

/**
 * The band fact over stored quotes. Window: `range` when given, else the latest 24 stored hours with a justlend-net row.
 * The latest 24 hours in it that have a justlend-net rate are judged by bandPass; the term premium is over every hour in it.
 * `spanHours` is the span of the hours judged (newest judged hour - oldest judged hour + 1; null when none is), not of the
 * window: a wider range whose latest 24 net hours are all present is `complete`, and judged hours spanning more than 24
 * (gaps in the net series) never are. Collect-only venues (src/index/gate.ts; PUBLISH_<VENUE> not `on`) are left out:
 * the fact goes into a public decision record.
 */
export async function bandFact(sql: Sql, range: HourRange | null, now: Date = new Date(), collectOnly: ReadonlySet<string> = collectOnlyVenues(process.env)) {
  const window = range ?? (await defaultBandWindow(sql));
  const quotes = window ? publishable(await quotesBetween(sql, window.from, window.to), collectOnly) : [];
  const hours = assembleBandHours(quotes).slice(-BAND_WINDOW_HOURS);
  const band = bandPass(hours);
  const first = hours[0];
  const last = hours.at(-1);
  const spanHours = first && last ? last.hour - first.hour + 1 : null;
  return {
    fact: "band" as const,
    from: window?.from ?? null,
    to: window?.to ?? null,
    spanHours,
    ...freshness(window?.to ?? null, now),
    ...band,
    complete: band.complete && spanHours !== null && spanHours <= BAND_WINDOW_HOURS,
    hours: hours.map((h) => ({ ...h, above: bandPass([h]).hoursAbove === 1 })),
    termPremium: venueTermPremiums(quotes),
    passCondition: BAND_PASS_CONDITION,
  };
}
