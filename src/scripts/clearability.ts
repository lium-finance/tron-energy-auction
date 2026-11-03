import { clearBatch, clearCorrected, type Order } from "../core/clear.js";
import { BAND_WINDOW_HOURS } from "../core/pass.js";
import { to4dp } from "../core/stats.js";
import { INSTRUMENT, type Quote } from "../core/types.js";
import { collectOnlyVenues, ConfigError } from "../index/config.js";
import { lastEnergyFeeRow, quotesBetween, type Sql } from "../index/db.js";
import { publishable } from "../index/gate.js";
import { SEED_ENERGY_FEE_SUN } from "../index/hour.js";
import { flagValue, shown } from "./args.js";
import { assembleBandHours, isDealerQuote, isNetQuote } from "./band.js";
import { freshness, type HourRange } from "./verify-facts.js";

/** The paper clearing's fixed terms: the supplier offers its idle-energy threshold, each bidder asks for the instrument, at most 35 % of offered supply each. */
export const SUPPLIER_OFFER_UNITS = 200_000_000;
export const BID_UNITS = INSTRUMENT.units;
export const CAP_SHARE = 0.35;
export const BIDDER_COUNTS = [2, 3] as const;
/** The burn price used when no chain row is stored, sun per unit: the same seed fee the hour job falls back to. */
export const DEFAULT_BURN_SUN = SEED_ENERGY_FEE_SUN;

export interface ClearabilityFlags {
  net?: number;
  dealer?: number;
  burn?: number;
}

const FLAGS = ["net", "dealer", "burn"] as const;
/** At most 4 decimals: the stored precision (numeric(12,4)). */
const DECIMAL = /^\d{1,6}(\.\d{1,4})?$/;

/** `--net <sun>`, `--dealer <sun>`, `--burn <sun>` (or `--net=<sun>`), each a positive decimal with at most 4 decimals; anything else is a ConfigError. */
export function parseClearabilityArgs(argv: readonly string[]): ClearabilityFlags {
  const out: ClearabilityFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--(net|dealer|burn)(?:=(.*))?$/.exec(arg);
    if (!m) throw new ConfigError(`unknown argument "${shown(arg)}"; use --net <sun>, --dealer <sun>, --burn <sun>`);
    const name = m[1] as (typeof FLAGS)[number];
    const { value, last } = flagValue(argv, i, m[2]);
    i = last;
    if (value === undefined) throw new ConfigError(`--${name} needs a value in sun`);
    if (name in out) throw new ConfigError(`--${name} is given twice`);
    const n = Number(value);
    if (!DECIMAL.test(value) || !Number.isFinite(n) || n <= 0) throw new ConfigError(`--${name} must be a positive number of sun with at most 4 decimals; got "${shown(value)}"`);
    out[name] = n;
  }
  return out;
}

export interface Input {
  /** Sun per unit (net: per unit-day, JustLend's rate). */
  value: number;
  source: "flag" | "db" | "default";
  /** The stored hour the value was read for; null for a flag or the default. */
  hour: number | null;
  /** For a dealer price from the database, the venue that quoted it. */
  venue?: string;
}

export interface Defaults {
  /** The hours searched: the latest 24 ending at the newest stored quote hour; null when no quote is stored. */
  window: HourRange | null;
  /** The latest hour with both a justlend-net rate and a dealer quote (the band's pairing): its net rate and its cheapest dealer quote. */
  paired: { hour: number; net: Input; dealer: Input } | null;
  /** The latest of each on its own, used only when the other input is given by flag. */
  latestNet: Input | null;
  latestDealer: Input | null;
  burn: Input;
}

/** From quotes in a window: the latest hour pairing a net rate with a dealer quote, and the latest net rate and dealer quote alone. */
export function defaultsFromQuotes(quotes: readonly Quote[]): Pick<Defaults, "paired" | "latestNet" | "latestDealer"> {
  let latestNet: Input | null = null;
  let latestDealer: Input | null = null;
  for (const q of quotes) {
    const p = q.sunPerUnit as number;
    if (isNetQuote(q) && (latestNet === null || q.hour > (latestNet.hour as number))) latestNet = { value: p, source: "db", hour: q.hour };
    if (isDealerQuote(q) && (latestDealer === null || q.hour > (latestDealer.hour as number) || (q.hour === latestDealer.hour && p < latestDealer.value))) {
      latestDealer = { value: p, source: "db", hour: q.hour, venue: q.venue };
    }
  }
  const last = assembleBandHours(quotes).filter((h) => h.cheapestSun !== null).at(-1);
  const paired = last
    ? { hour: last.hour, net: { value: last.justlendNetSun, source: "db" as const, hour: last.hour }, dealer: { value: last.cheapestSun as number, source: "db" as const, hour: last.hour, venue: last.cheapestVenue as string } }
    : null;
  return { paired, latestNet, latestDealer };
}

/** The defaults when nothing is read from the database (every input given by flag): no stored rows, the default burn price. */
export const NO_STORED_DEFAULTS: Defaults = { window: null, paired: null, latestNet: null, latestDealer: null, burn: { value: DEFAULT_BURN_SUN, source: "default", hour: null } };

/**
 * The database defaults: net and dealer from the latest 24 stored quote hours, burn from the newest chain row at or before
 * that window's end. Collect-only venues (src/index/gate.ts) are never a default: the result goes into a public decision record.
 */
export async function clearabilityDefaults(sql: Sql, collectOnly: ReadonlySet<string> = collectOnlyVenues(process.env)): Promise<Defaults> {
  const [latest] = await sql<{ hour: string | null }[]>`select max(hour)::text as hour from quotes`;
  const to = latest?.hour == null ? null : Number(latest.hour);
  const window = to === null ? null : { from: to - (BAND_WINDOW_HOURS - 1), to };
  const found = window ? defaultsFromQuotes(publishable(await quotesBetween(sql, window.from, window.to), collectOnly)) : { paired: null, latestNet: null, latestDealer: null };
  const fee = await lastEnergyFeeRow(sql, to ?? Number.MAX_SAFE_INTEGER);
  const burn: Input = fee && fee.fee > 0 ? { value: fee.fee, source: "db", hour: fee.hour } : { value: DEFAULT_BURN_SUN, source: "default", hour: null };
  return { window, ...found, burn };
}

/**
 * Why the paper clearing was not run. no-dealer-quote: no depth-aware quote at all (in the window, or beside a --net flag);
 * no-paired-hour: net rates and depth-aware quotes are both stored, but never in the same hour.
 */
export type Reason = "no-net-rate" | "no-dealer-quote" | "no-paired-hour" | "no-band" | "dealer-above-burn" | "band-too-narrow";

export interface Resolution {
  net: Input | null;
  dealer: Input | null;
  burn: Input;
  /** Why the paper clearing was not run; null when it was. */
  reason: Reason | null;
  message: string | null;
}

const where = (w: HourRange | null): string => (w ? `in hours ${w.from} to ${w.to}` : "(no quotes are stored)");
const stated = (name: string, i: Input): string => `${name} ${i.value} (${i.source}${i.hour !== null ? `, hour ${i.hour}` : ""})`;
const STEP = 1e-4;
const ticks = (x: number): number => Math.round(x / STEP);
const MAX_BIDDERS = Math.max(...BIDDER_COUNTS);

/**
 * Flags win over the database. With neither net nor dealer given by flag, both come from the same stored hour (`paired`); with
 * one given, the other is the latest stored on its own. A failed check on stored or default inputs only is a result with a
 * reason code (the fact is that there is no band to clear in); a failed check that involves a flag is a ConfigError (exit 2).
 * A band narrower than (bidders + 1) * 0.0001 sun leaves no room for distinct bids: band-too-narrow, whatever the sources.
 */
export function resolveInputs(flags: ClearabilityFlags, d: Defaults): Resolution {
  const flag = (v: number | undefined): Input | null => (v === undefined ? null : { value: v, source: "flag", hour: null });
  const fromDb = flags.net === undefined && flags.dealer === undefined ? d.paired : null;
  const net = flag(flags.net) ?? (fromDb ? fromDb.net : flags.dealer !== undefined ? d.latestNet : null);
  const dealer = flag(flags.dealer) ?? (fromDb ? fromDb.dealer : flags.net !== undefined ? d.latestDealer : null);
  const burn = flag(flags.burn) ?? d.burn;
  const result = (reason: Reason, message: string): Resolution => ({ net, dealer, burn, reason, message });
  const fail = (inputs: Input[], reason: Reason, message: string): Resolution => {
    if (inputs.some((i) => i.source === "flag")) throw new ConfigError(message);
    return result(reason, message);
  };
  if (!net && (flags.dealer !== undefined || !d.latestNet)) return result("no-net-rate", `no justlend-net rate stored ${where(d.window)}; pass --net <sun> to run the paper clearing on a stated net alternative`);
  if (!net || !dealer) {
    if (flags.net === undefined && d.latestNet && d.latestDealer) {
      return result(
        "no-paired-hour",
        `justlend-net rates and depth-aware quotes are both stored ${where(d.window)} but never in the same hour (latest net hour ${d.latestNet.hour}, latest quote hour ${d.latestDealer.hour}); pass --net <sun> or --dealer <sun> to run the paper clearing on a stated input`,
      );
    }
    return result("no-dealer-quote", `no depth-aware quote (status ok, 20,000,000 units for 1 hour, depth >= 20,000,000) ${where(d.window)}; pass --dealer <sun> to run the paper clearing on a stated dealer price`);
  }
  if (!(net.value < dealer.value)) return fail([net, dealer], "no-band", `no band to bid inside: ${stated("dealer", dealer)} is not above ${stated("net", net)}`);
  if (!(dealer.value <= burn.value)) return fail([dealer, burn], "dealer-above-burn", `${stated("dealer", dealer)} is above ${stated("burn", burn)}`);
  if (ticks(dealer.value - net.value) < MAX_BIDDERS + 1) {
    return result("band-too-narrow", `the band ${to4dp(dealer.value - net.value)} sun is narrower than ${to4dp((MAX_BIDDERS + 1) * STEP)}, too narrow for ${MAX_BIDDERS} distinct bids 0.0001 apart`);
  }
  return { net, dealer, burn, reason: null, message: null };
}

/** `n` bids evenly spaced inside (net, dealer), 4 dp (the stored precision), clamped to [net + 0.0001, dealer - 0.0001], each for the instrument's units. */
export function bidsInside(net: number, dealer: number, n: number): Order[] {
  const lo = to4dp(net + STEP);
  const hi = to4dp(dealer - STEP);
  return Array.from({ length: n }, (_, i) => ({ priceSun: Math.min(hi, Math.max(lo, to4dp(net + ((dealer - net) * (i + 1)) / (n + 1)))), energy: BID_UNITS }));
}

export const CLEARABILITY_PASS_CONDITION =
  "the hour clears at a positive price under the corrected rule (asks fixed before bids, cap 35 % of offered supply, reserve floor = the supplier's net alternative) for 1 supplier and 2 and 3 bidders inside the band";

export const CLEARABILITY_NOTE = "passes by construction whenever a band exists; read with verify-band";

/**
 * The paper clearing: one supplier asking at its net alternative for 200,000,000 units, against 2 then 3 bidders inside
 * (net, dealer), under both rules. `hour` is the stored hour the database inputs were read for (null when net and dealer are
 * both flags); a resolution with a reason is reported as pass false with no cases.
 */
export function clearabilityFact(r: Resolution, window: HourRange | null = null, now: Date = new Date()) {
  const { net, dealer, burn } = r;
  const dbHours = [net, dealer].filter((i): i is Input => i !== null && i.source === "db").map((i) => i.hour as number);
  const hour = dbHours.length ? Math.max(...dbHours) : null;
  const cases =
    r.reason === null && net && dealer
      ? BIDDER_COUNTS.map((n) => {
          const supplier: Order[] = [{ priceSun: net.value, energy: SUPPLIER_OFFER_UNITS }];
          const bids = bidsInside(net.value, dealer.value, n);
          return {
            bidders: n,
            bids,
            research: clearBatch(bids, supplier, burn.value),
            corrected: clearCorrected(bids, supplier, { capShare: CAP_SHARE, reserveFloorSun: net.value, maxBidSun: burn.value }),
          };
        })
      : [];
  return {
    fact: "clearability" as const,
    pass: cases.length > 0 && cases.every((c) => c.corrected.priceSun !== null && c.corrected.priceSun > 0),
    reason: r.reason,
    message: r.message,
    hour,
    ...freshness(hour, now),
    bandWidthSun: net && dealer ? to4dp(dealer.value - net.value) : null,
    inputs: { netSun: net, dealerSun: dealer, burnSun: burn },
    window,
    supplier: { askSun: net?.value ?? null, energy: SUPPLIER_OFFER_UNITS },
    capShare: CAP_SHARE,
    cases,
    note: CLEARABILITY_NOTE,
    rules: "research is the research post's rule (clearBatch), kept for comparison; the pass is decided by the corrected rule (clearCorrected)",
    passCondition: CLEARABILITY_PASS_CONDITION,
  };
}
