import { hourOf } from "../core/hour.js";
import { FULL_DAY_HOURS, MAX_ESTIMATED_HOURS, SUPPLIER_IDLE_UNITS_PER_DAY, UTILISATION_MARKUP, UTILISATION_SCARCITY, supplierPass, utilisationPass, type WalletRead } from "../core/pass.js";
import { ConfigError } from "../index/config.js";
import type { Sql } from "../index/db.js";
import type { Wallets } from "../index/wallet-list.js";
import { HOUR_ARG, shown } from "./args.js";

/**
 * Hours a fact looks at by default: a full day's 24 hourly steps, plus the 2 unread hours a full day allows, plus 1, so a
 * wallet missing an edge hour (its newest read not yet taken when the fact runs, or its first one missed) still spans 24.
 * pass.ts keeps each wallet's latest 25 reads inside it.
 */
export const DEFAULT_WINDOW_HOURS = FULL_DAY_HOURS + MAX_ESTIMATED_HOURS + 1;
/** A window whose last hour is more than this many hours old is reported as stale. */
export const STALE_HOURS = 2;
/**
 * A result within about 2 % of a threshold is reported as marginal: a use in the middle of an hour has already decayed a
 * little by the next read, so the hourly reconstruction can be off by about that much.
 */
export const MARGIN = 0.02;

export interface HourRange {
  from: number;
  to: number;
}

/**
 * The optional `[from] [to]` arguments, in unix hours, both inclusive. None: null (the script's default window).
 * Only `from`: `windowHours` hours from it (27 by default, so from to from + 26). Anything that is not a whole number, or a
 * `to` before `from`, is a ConfigError.
 */
export function parseRangeArgs(fromArg: string | undefined, toArg: string | undefined, windowHours: number = DEFAULT_WINDOW_HOURS): HourRange | null {
  if (fromArg === undefined) return null;
  if (!HOUR_ARG.test(fromArg)) throw new ConfigError(`from must be a unix hour; got "${shown(fromArg)}"`);
  const from = Number(fromArg);
  if (toArg === undefined) return { from, to: from + windowHours - 1 };
  if (!HOUR_ARG.test(toArg)) throw new ConfigError(`to must be a unix hour; got "${shown(toArg)}"`);
  const to = Number(toArg);
  if (to < from) throw new ConfigError(`to (${to}) is before from (${from})`);
  return { from, to };
}

/**
 * Per-wallet, per-hour rows from `verification` for the listed wallets within the range, oldest first. With no range,
 * the latest 27 hours ending at the newest hour stored for any of these wallets; with no rows at all, from and to are null.
 */
export async function verificationRows(sql: Sql, wallets: readonly string[], range: HourRange | null): Promise<{ from: number | null; to: number | null; rows: WalletRead[] }> {
  let r = range;
  if (!r) {
    const [latest] = await sql<{ hour: string | null }[]>`select max(hour)::text as hour from verification where wallet = any(${wallets as string[]})`;
    if (!latest || latest.hour === null) return { from: null, to: null, rows: [] };
    const to = Number(latest.hour);
    r = { from: to - (DEFAULT_WINDOW_HOURS - 1), to };
  }
  const rows = await sql<{ wallet: string; hour: string; energy_limit: string; energy_used: string }[]>`
    select wallet, hour::text as hour, energy_limit::text as energy_limit, energy_used::text as energy_used
    from verification where wallet = any(${wallets as string[]}) and hour between ${r.from} and ${r.to}
    order by wallet, hour`;
  return {
    from: r.from,
    to: r.to,
    rows: rows.map((x) => ({ wallet: x.wallet, hour: Number(x.hour), energyLimit: Number(x.energy_limit), energyUsed: Number(x.energy_used) })),
  };
}

/**
 * What the utilisation number is, stated beside it: the reads see only energy the stakers keep, so a reader must not take
 * the figure for the utilisation of all staked energy.
 */
export const UTILISATION_MEASURES =
  "utilisation of energy the listed stakers keep (EnergyUsed / EnergyLimit from hourly deltas); energy they delegate out is used by its recipients and is not counted, so this is a lower bound on how busy the listed stake is";

/** The share of the list's energy stake delegated out (6 decimals); null when the list has no stake numbers or no stake. */
function delegatedOutShare(t: Wallets["top100"]["stakeTotals"]): number | null {
  if (!t || !(t.energyStakeTrx > 0)) return null;
  return Math.round((t.delegatedOutTrx / t.energyStakeTrx) * 1e6) / 1e6;
}

const near = (value: number, threshold: number): boolean => Math.abs(value - threshold) <= MARGIN * threshold;
const distinctWallets = (rows: readonly WalletRead[]): number => new Set(rows.map((r) => r.wallet)).size;

/** How old the window's last hour is, against the current hour; stale when more than 2. Null with no window. */
export function freshness(to: number | null, now: Date): { hoursSinceTo: number | null; stale: boolean } {
  if (to === null) return { hoursSinceTo: null, stale: false };
  const hoursSinceTo = hourOf(now) - to;
  return { hoursSinceTo, stale: hoursSinceTo > STALE_HOURS };
}

/**
 * The supplier fact over the supplier's wallets. supplierPass judges the wallets that have reads; a listed wallet with
 * no read in the range also makes the fact incomplete (and so not a pass), since its idle energy is unknown.
 */
export async function supplierFact(sql: Sql, w: Wallets, range: HourRange | null, now: Date = new Date()) {
  const { from, to, rows } = await verificationRows(sql, w.supplier, range);
  const r = supplierPass(rows);
  const walletsMissing = w.supplier.length - distinctWallets(rows);
  const complete = r.complete && walletsMissing === 0;
  return {
    fact: "supplier" as const,
    from,
    to,
    ...freshness(to, now),
    rows: rows.length,
    pass: r.pass && complete,
    idleUnitsPerDay: r.idleUnitsPerDay,
    complete,
    wallets: r.wallets,
    walletsListed: w.supplier.length,
    walletsMissing,
    marginal: r.wallets > 0 && near(r.idleUnitsPerDay, SUPPLIER_IDLE_UNITS_PER_DAY),
    passCondition: "idle energy (mean limit minus energy burned per day, from hourly deltas) >= 200,000,000 units a day, every listed wallet with a full day of reads",
  };
}

/**
 * The utilisation fact over the top-100 list. utilisationPass uses only wallets with a full day; a listed wallet with
 * no read in the range also makes the fact incomplete (and so not a pass).
 */
export async function utilisationFact(sql: Sql, w: Wallets, range: HourRange | null, now: Date = new Date()) {
  const { from, to, rows } = await verificationRows(sql, w.top100.wallets, range);
  const r = utilisationPass(rows);
  const walletsMissing = w.top100.wallets.length - distinctWallets(rows);
  const complete = r.complete && walletsMissing === 0;
  return {
    fact: "utilisation" as const,
    from,
    to,
    ...freshness(to, now),
    rows: rows.length,
    listSource: w.top100.source,
    listReadAt: w.top100.readAt,
    shareOfTotalEnergyWeight: w.top100.shareOfTotalEnergyWeight,
    pass: r.pass && complete,
    framing: r.framing,
    utilisation: r.utilisation,
    complete,
    wallets: r.wallets,
    walletsListed: w.top100.wallets.length,
    walletsMissing,
    marginal: r.utilisation !== null && (near(r.utilisation, UTILISATION_SCARCITY) || near(r.utilisation, UTILISATION_MARKUP)),
    delegatedOutShare: delegatedOutShare(w.top100.stakeTotals),
    measures: UTILISATION_MEASURES,
    passCondition: "energy burned per day / energy limit (from hourly deltas) >= 85 % is scarcity, the pass; < 70 % markup market; every listed wallet with a full day of reads",
  };
}
