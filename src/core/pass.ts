/**
 * Supplier: idle energy a day that fills the 20,000,000-unit instrument for ten hours, the least that lets a pilot
 * print more than one price a day.
 */
export const SUPPLIER_IDLE_UNITS_PER_DAY = 200_000_000;
/** Utilisation at or above this is scarcity (the pass): below it an auction competes on price with idle stake. */
export const UTILISATION_SCARCITY = 0.85;
/** Utilisation below this frames the index as a markup market; between the two, neither claim is made. */
export const UTILISATION_MARKUP = 0.7;
/** Band: the cheapest depth-aware quote must sit at least this many sun above the supplier's net JustLend rate... */
export const BAND_SUN = 5;
/** ...in at least this many of the 24 hours judged. */
export const BAND_HOURS = 12;
/** A 7- or 14-day price per unit-day at least this share above the 1-day price is a term premium. */
export const TERM_PREMIUM = 0.1;

export interface WalletRead {
  wallet: string;
  /** The hour of the read (epoch hours); later is newer. */
  hour: number;
  energyLimit: number;
  energyUsed: number;
}

const finite = (n: number): boolean => Number.isFinite(n);

/** Hourly reads kept per wallet: 25 reads make 24 hourly steps. */
const READS_KEPT = 25;
const HOURS_PER_DAY = 24;
/** java-tron's decay window: stored usage decays linearly to zero over 24 hours. */
const DECAY_HOURS = 24;

/** One wallet's usable reads: finite only, deduped by hour (last wins), oldest first, the latest 25. */
function cleanReads(reads: readonly WalletRead[]): WalletRead[] {
  const byHour = new Map<number, WalletRead>();
  for (const r of reads) {
    if (finite(r.hour) && finite(r.energyLimit) && finite(r.energyUsed)) byHour.set(r.hour, r);
  }
  return [...byHour.values()].sort((a, b) => a.hour - b.hour).slice(-READS_KEPT);
}

/**
 * Energy a wallet burned over its kept window (the latest 25 reads), rebuilt from the deltas of its own reads (ONE wallet).
 *
 * Why not the raw snapshot: `EnergyUsed` from getaccountresource is not "used today". In java-tron
 * (EnergyProcessor.increase) every use does `stored = stored * (1 - dt / W) + use` with W = 24 h, and a read returns the
 * stored value decayed to now. So a wallet that burned 100M an hour ago and nothing since still reads a large `EnergyUsed`,
 * and a steadily busy wallet reads the decayed sum, not what was burned. Between two reads `gap` hours apart,
 * what was burned is `used_t - used_prev * (1 - gap / 24)`, clamped at 0 (a quiet wallet only decays).
 *
 * `steps` is the number of read pairs. `spanHours` is last.hour - first.hour of the window: the time the units cover, so a
 * per-day figure is `units * 24 / spanHours`, never `units * 24 / steps`. `estimatedSteps` counts the hours inside the window
 * that no read brackets one by one: sum of max(0, gap - 1) over the pairs. Over a gap the decay is exact but uses inside it are
 * netted together, so those hours are an estimate.
 */
export function dailyConsumption(reads: readonly WalletRead[]): { units: number; steps: number; estimatedSteps: number; spanHours: number } {
  const rs = cleanReads(reads);
  let units = 0;
  let estimatedSteps = 0;
  for (let i = 1; i < rs.length; i++) {
    const prev = rs[i - 1]!;
    const cur = rs[i]!;
    const gap = cur.hour - prev.hour;
    units += Math.max(0, cur.energyUsed - prev.energyUsed * Math.max(0, 1 - gap / DECAY_HOURS));
    estimatedSteps += Math.max(0, gap - 1);
  }
  const spanHours = rs.length > 1 ? rs[rs.length - 1]!.hour - rs[0]!.hour : 0;
  return { units, steps: Math.max(0, rs.length - 1), estimatedSteps, spanHours };
}

/** A wallet has a "full day" when its window spans at least 24 hours with at most two hours not read one by one. */
export const FULL_DAY_HOURS = 24;
export const MAX_ESTIMATED_HOURS = 2;

interface WalletSummary {
  meanLimit: number;
  /** Consumption per day: units * 24 / spanHours; 0 when the window has no span. */
  perDay: number;
  full: boolean;
}

function summarise(reads: readonly WalletRead[]): WalletSummary[] {
  const groups = new Map<string, WalletRead[]>();
  for (const r of reads) {
    const g = groups.get(r.wallet);
    if (g) g.push(r);
    else groups.set(r.wallet, [r]);
  }
  const out: WalletSummary[] = [];
  for (const g of groups.values()) {
    const rs = cleanReads(g);
    if (rs.length === 0) continue;
    const { units, estimatedSteps, spanHours } = dailyConsumption(rs);
    out.push({
      meanLimit: rs.reduce((s, r) => s + r.energyLimit, 0) / rs.length,
      perDay: spanHours > 0 ? (units * HOURS_PER_DAY) / spanHours : 0,
      full: spanHours >= FULL_DAY_HOURS && estimatedSteps <= MAX_ESTIMATED_HOURS,
    });
  }
  return out;
}

/**
 * Idle energy per day across the supplier's wallets: for each wallet, mean energy limit minus the energy it burned per day
 * (see dailyConsumption for the decay model, why the raw `EnergyUsed` snapshot is not used, and the per-day scaling), summed and
 * floored. Passes only at 200,000,000 or more AND when every wallet has a full day (24 hours of near-hourly reads); `complete`
 * reports the second condition.
 */
export function supplierPass(reads: readonly WalletRead[]): { pass: boolean; idleUnitsPerDay: number; complete: boolean; wallets: number } {
  const ws = summarise(reads);
  if (ws.length === 0) return { pass: false, idleUnitsPerDay: 0, complete: false, wallets: 0 };
  const idle = ws.reduce((s, w) => s + Math.max(0, w.meanLimit - w.perDay), 0);
  const idleUnitsPerDay = Math.floor(Math.round(idle * 1e3) / 1e3);
  const complete = ws.every((w) => w.full);
  return { pass: complete && idleUnitsPerDay >= SUPPLIER_IDLE_UNITS_PER_DAY, idleUnitsPerDay, complete, wallets: ws.length };
}

/**
 * Utilisation of the top stakers: energy burned per day (rebuilt from hourly deltas and scaled by elapsed hours, see
 * dailyConsumption; the raw decaying `EnergyUsed` snapshot is not used) over mean energy limit, summed over the wallets with a
 * full day. `complete` is true when at least one wallet is full and every wallet with at least one read is full; a pass needs
 * `complete`. `wallets` counts the wallets the ratio used. No full wallet, or a zero total limit, is "insufficient", never a pass.
 */
export function utilisationPass(reads: readonly WalletRead[]): {
  pass: boolean;
  framing: "scarcity" | "markup" | "neither" | "insufficient";
  utilisation: number | null;
  complete: boolean;
  wallets: number;
} {
  const all = summarise(reads);
  const ws = all.filter((w) => w.full);
  const limit = ws.reduce((s, w) => s + w.meanLimit, 0);
  if (ws.length === 0 || limit === 0) return { pass: false, framing: "insufficient", utilisation: null, complete: false, wallets: 0 };
  // Snapped to 1e-9 so decay arithmetic noise cannot flip a boundary such as exactly 0.85 or 0.70.
  const utilisation = Math.round((ws.reduce((s, w) => s + w.perDay, 0) / limit) * 1e9) / 1e9;
  const framing = utilisation >= UTILISATION_SCARCITY ? "scarcity" : utilisation < UTILISATION_MARKUP ? "markup" : "neither";
  const complete = ws.length === all.length;
  return { pass: complete && framing === "scarcity", framing, utilisation, complete, wallets: ws.length };
}

export interface BandHour {
  /** The hour this row is for (epoch hours or any strictly increasing hour index); later hours are newer. */
  hour: number;
  /** The cheapest live quote with 20,000,000 depth in that hour, sun per unit; null when none. */
  cheapestSun: number | null;
  /** JustLend's daily rate that hour, net of its reserve factor, sun per unit-day. */
  justlendNetSun: number;
}

/** Hours the band fact judges: the latest 24 distinct hours. */
export const BAND_WINDOW_HOURS = 24;

/**
 * Only the latest 24 distinct hours count; a repeated hour is counted once (last row wins).
 * A missing or non-finite quote or rate is not above. `complete` says whether a full day was observed.
 */
export function bandPass(hours: readonly BandHour[]): { pass: boolean; hoursAbove: number; hoursObserved: number; complete: boolean } {
  const byHour = new Map<number, BandHour>();
  for (const h of hours) byHour.set(h.hour, h);
  const latest = [...byHour.values()].sort((a, b) => b.hour - a.hour).slice(0, BAND_WINDOW_HOURS);
  const hoursAbove = latest.filter(
    (h) =>
      h.cheapestSun !== null &&
      finite(h.cheapestSun) &&
      finite(h.justlendNetSun) &&
      Math.round((h.cheapestSun - h.justlendNetSun) * 1e6) >= BAND_SUN * 1e6,
  ).length;
  const hoursObserved = byHour.size;
  return { pass: hoursAbove >= BAND_HOURS, hoursAbove, hoursObserved, complete: hoursObserved >= BAND_WINDOW_HOURS };
}

/**
 * Prices per unit-day; `exists` is decided on the unrounded ratio, only the reported `premium` is rounded (4 dp, so a
 * percentage with 2 decimals). A premium exists when 7- or 14-day exceeds 1-day by TERM_PREMIUM or more. One that does not
 * is rounded down, so it is always reported under TERM_PREMIUM (9.999 % is 0.0999, never 0.1). Non-finite d7/d14 are
 * ignored; with no usable term price, or a d1 that is not a finite positive number, there is no premium (null).
 */
export function termPremium(p: { d1PerDay: number; d7PerDay: number | null; d14PerDay: number | null }): { exists: boolean; premium: number | null } {
  const terms = [p.d7PerDay, p.d14PerDay].filter((x): x is number => x !== null && finite(x));
  if (terms.length === 0 || !finite(p.d1PerDay) || p.d1PerDay <= 0) return { exists: false, premium: null };
  const ratio = (Math.max(...terms) - p.d1PerDay) / p.d1PerDay;
  const exists = ratio >= TERM_PREMIUM - 1e-9;
  // The 1e-6 absorbs float error (0.0995 is 994.9999... ten-thousandths) and cannot lift a ratio under the threshold to it.
  const premium = (exists ? Math.round(ratio * 10_000) : Math.floor(ratio * 10_000 + 1e-6)) / 10_000;
  return { exists, premium };
}
