import type { ChainResult, EnergyStakeResult } from "../collectors/chain.js";
import { defaultSleep, pacer } from "../collectors/pace.js";
import { TRON_ADDRESS } from "../core/address.js";
import { SUN_PER_TRX } from "../core/types.js";
import { ConfigError } from "../index/config.js";
import { shown } from "./args.js";

/** Tronscan's keyless account list; `sort=-power` ranks by total staked TRX (docs/verification/top100-source.md). */
export const TRONSCAN_LIST = "https://apilist.tronscanapi.com/api/account/list";
export const GETACCOUNT = "https://api.trongrid.io/wallet/getaccount";
/** Accepted by the endpoint on 2026-10-22 (a 50-row page was probed); larger pages were not tried. */
export const PAGE_SIZE = 50;
/** Tronscan is keyless here: at most one page every 2 s. */
export const PAGE_GAP_MS = 2_000;
export const K_DEFAULT = 300;
/** Tronscan's list stops at 10,000 accounts (its `total`). */
export const K_MAX = 10_000;
export const TOP_N = 100;

export const rankingUrl = (start: number, limit: number): string => `${TRONSCAN_LIST}?sort=-power&limit=${limit}&start=${start}`;

export interface Ranked {
  address: string;
  /** Tronscan's `power`: total staked TRX in sun, energy and bandwidth together. */
  powerSun: number;
}

export interface Staked extends Ranked {
  /** Own energy stake in sun (readAccountEnergyStake), kept and delegated out together. */
  energyStakeSun: number;
  /** The part delegated out, in sun; optional so a ranking can be judged on stakes alone. */
  delegatedOutSun?: number;
}

/** One listed wallet with its stake numbers, in TRX (sun / 1,000,000). */
export interface Top100Wallet {
  address: string;
  energyStakeTrx: number;
  delegatedOutTrx: number;
}

/** One page of the ranking: only `data[].address` and `data[].power` are read. Throws on anything else. */
export function parseRankingPage(text: string): Ranked[] {
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) throw new Error("ranking page has no data array");
  return ((body as { data: unknown[] }).data).map((row, i) => {
    const r = row as { address?: unknown; power?: unknown };
    if (typeof r.address !== "string" || !TRON_ADDRESS.test(r.address)) throw new Error(`data[${i}].address is not a Tron address`);
    if (typeof r.power !== "number" || !Number.isFinite(r.power) || r.power < 0) throw new Error(`data[${i}].power is not a number of at least zero`);
    return { address: r.address, powerSun: r.power };
  });
}

/**
 * The top `n` accounts by own energy stake among the K ranked by total stake (accounts with no energy stake are left out).
 * Exact when n were found and the n-th energy stake is at least the K-th account's total stake: an account outside the
 * K has at most that much total stake, so at most that much energy stake, and cannot displace any of the n. Also needs
 * every energy stake to be at most its account's total stake, which the bound assumes.
 *
 * Tronscan's `power` is an indexed snapshot (its rows carry an `updateTime`), not a chain read, and the getaccount reads
 * come minutes later: a stake that moved in between can make the bound slightly off. The stake-above-power check catches
 * the cases where it rose.
 */
export function selectTop(accounts: readonly Staked[], n = TOP_N): { top: Staked[]; exact: boolean; kthPowerSun: number | null; nthStakeSun: number | null } {
  const kthPowerSun = accounts.length > 0 ? Math.min(...accounts.map((a) => a.powerSun)) : null;
  const top = accounts
    .filter((a) => a.energyStakeSun > 0)
    .sort((a, b) => b.energyStakeSun - a.energyStakeSun || (a.address < b.address ? -1 : 1))
    .slice(0, n);
  const nthStakeSun = top.length === n ? top[n - 1]!.energyStakeSun : null;
  const consistent = accounts.every((a) => a.energyStakeSun <= a.powerSun);
  return { top, exact: nthStakeSun !== null && kthPowerSun !== null && consistent && nthStakeSun >= kthPowerSun, kthPowerSun, nthStakeSun };
}

/** Sum of the stakes in TRX over TotalEnergyWeight (TRX), to 6 decimals; a share above 1 means the inputs disagree and throws. */
export function shareOfTotalEnergyWeight(top: readonly Staked[], totalEnergyWeightTrx: number): number {
  if (!(totalEnergyWeightTrx > 0)) throw new Error("TotalEnergyWeight is not positive");
  const share = top.reduce((s, a) => s + a.energyStakeSun, 0) / SUN_PER_TRX / totalEnergyWeightTrx;
  if (share > 1) throw new Error(`the top stakes add up to more than TotalEnergyWeight (${share})`);
  return Math.round(share * 1e6) / 1e6;
}

export interface Top100Section {
  source: string;
  readAt: string;
  k: number;
  exact: boolean;
  shareOfTotalEnergyWeight: number;
  /** Totals over the listed wallets, in TRX, and delegatedOutTrx / energyStakeTrx (6 decimals). */
  energyStakeTrx: number;
  delegatedOutTrx: number;
  delegatedOutShare: number;
  wallets: Top100Wallet[];
}

const toTrx = (sun: number): number => sun / SUN_PER_TRX;

export interface BuildDeps {
  k: number;
  fetchPage: (url: string) => Promise<{ ok: true; body: string } | { ok: false; reason: string }>;
  readStake: (address: string, now: Date) => Promise<EnergyStakeResult>;
  readWeight: (now: Date) => Promise<ChainResult>;
  log: (line: string) => void;
  /** TronGrid requests a second (VERIFY_RPS); default 2. */
  rps?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/**
 * Builds the top100 section: the top K by total stake from Tronscan (pages at least 2 s apart), each account's own energy
 * stake from TronGrid getaccount (paced at `rps`, a rate limit retried once), then TotalEnergyWeight. Any failed page or
 * read, or a ranking that is not in order or repeats an account (it shifted between pages), throws: a partial ranking
 * cannot be trusted. Not exact is not an error; it is logged with the advice to raise K.
 */
export async function buildTop100(d: BuildDeps): Promise<Top100Section> {
  const clock = d.clock ?? Date.now;
  const sleep = d.sleep ?? defaultSleep;
  const readAt = new Date(clock()).toISOString();

  const ranked: Ranked[] = [];
  // Pages go through their own pacer: at most one every 2 s, and a rate-limited page is retried once 2 s later.
  const pagePace = pacer({ rps: 1000 / PAGE_GAP_MS, sleep, clock });
  for (let start = 0; start < d.k; start += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, d.k - start);
    const r = await pagePace.run(() => d.fetchPage(rankingUrl(start, limit)), () => d.log(`top100: Tronscan page start=${start} rate limited; retrying once`));
    if (!r || !r.ok) throw new Error(`Tronscan ranking (start=${start}) failed: ${r ? r.reason : "not started"}`);
    const page = parseRankingPage(r.body);
    ranked.push(...page);
    if (page.length < limit) break;
  }
  const seen = new Set<string>();
  ranked.forEach((a, i) => {
    if (seen.has(a.address)) throw new Error(`the ranking repeats an account at rank ${i + 1}; it shifted between pages, run again`);
    seen.add(a.address);
    if (i > 0 && a.powerSun > ranked[i - 1]!.powerSun) throw new Error(`the ranking is not in order at position ${i + 1}; run again`);
  });
  d.log(`top100: ${ranked.length} accounts ranked by total stake`);

  const pace = pacer({ rps: d.rps, sleep, clock });
  const staked: Staked[] = [];
  // Progress and errors name accounts by rank, never by address; the output file keeps the addresses.
  for (const [i, a] of ranked.entries()) {
    const rank = `rank ${i + 1}`;
    const r = await pace.run((now) => d.readStake(a.address, now), () => d.log(`top100: getaccount ${rank} rate limited; retrying once`));
    if (!r || !r.ok) throw new Error(`getaccount failed for ${rank}: ${r ? r.reason.split(a.address).join(rank) : "not started"}`);
    staked.push({ ...a, energyStakeSun: r.energyStakeSun, delegatedOutSun: r.delegatedOutSun });
  }
  const w = await pace.run((now) => d.readWeight(now), () => d.log("top100: chain parameters rate limited; retrying once"));
  if (!w || !w.ok) throw new Error(`reading TotalEnergyWeight failed: ${w ? w.reason : "not started"}`);

  const { top, exact, kthPowerSun, nthStakeSun } = selectTop(staked);
  if (top.length === 0) throw new Error("no ranked account has an energy stake");
  const trx = (sun: number | null): string => (sun === null ? "none" : `${Math.round(sun / SUN_PER_TRX)} TRX`);
  d.log(
    exact
      ? `top100: exact (100th energy stake ${trx(nthStakeSun)} >= total stake of account #${ranked.length} ${trx(kthPowerSun)})`
      : `top100: NOT exact (${top.length} found; 100th energy stake ${trx(nthStakeSun)}, total stake of account #${ranked.length} ${trx(kthPowerSun)}); raise --k and run again`,
  );
  const stakeSun = top.reduce((s, a) => s + a.energyStakeSun, 0);
  const delegatedSun = top.reduce((s, a) => s + (a.delegatedOutSun ?? 0), 0);
  return {
    source: `${TRONSCAN_LIST}?sort=-power (top ${d.k} by total stake) + ${GETACCOUNT} (frozenV2 ENERGY + energy delegated out + Stake 1.0 energy)`,
    readAt,
    k: d.k,
    exact,
    shareOfTotalEnergyWeight: shareOfTotalEnergyWeight(top, w.params.totalEnergyWeightTrx),
    energyStakeTrx: toTrx(stakeSun),
    delegatedOutTrx: toTrx(delegatedSun),
    delegatedOutShare: Math.round((delegatedSun / stakeSun) * 1e6) / 1e6,
    wallets: top.map((a) => ({ address: a.address, energyStakeTrx: toTrx(a.energyStakeSun), delegatedOutTrx: toTrx(a.delegatedOutSun ?? 0) })),
  };
}

/** `build-top100 <out.json> [--k N]`: the out path is required (nothing is written into the repo unless you name a path there). */
export function parseBuildArgs(argv: readonly string[]): { out: string; k: number } {
  let out: string | undefined;
  let k = K_DEFAULT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--k") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > K_MAX) throw new ConfigError(`--k must be a whole number from 1 to ${K_MAX}`);
      k = Number(v);
    } else if (a.startsWith("-")) {
      throw new ConfigError(`unknown option ${shown(a)}`);
    } else if (out === undefined) {
      out = a;
    } else {
      throw new ConfigError("give one output path");
    }
  }
  if (!out) throw new ConfigError("usage: build-top100 <out.json> [--k N]");
  return { out, k };
}
