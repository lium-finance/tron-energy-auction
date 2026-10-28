import { collectAll, type CollectContext, type VenueAdapter } from "../collectors/adapter.js";
import type { ChainResult } from "../collectors/chain.js";
import type { FetchOptions } from "../collectors/http.js";
import { print } from "../core/print.js";
import type { Print, Quote } from "../core/types.js";
import { hasPrint, insertChain, insertPayloads, insertPrint, insertQuotes, lastEnergyFeeRow, lastPrint, printForHour, quotesForHour, type Sql } from "./db.js";
import { errorMessage } from "../core/errors.js";
import { allGatedVenues, publishable } from "./gate.js";

export interface HourDeps {
  sql: Sql;
  venues: readonly VenueAdapter[];
  readChain: (hour: number, now: Date) => Promise<ChainResult>;
  /** CoinGecko; its failure reason is not redacted, the job redacts it before logging. */
  readTrxUsd?: () => Promise<{ ok: true; trxUsd: number } | { ok: false; reason: string }>;
  fetchOptions: FetchOptions;
  /** Absent in collect-only mode (PUBLISH=off): no files are written. */
  publish?: (hour: number, p: Print, quotes: Quote[]) => Promise<void>;
  /**
   * The dead-man ping, present whenever HEALTHCHECK_PING_URL is set, in either mode, so a deployment that
   * collects without publishing is watched too. Sent by the run that inserted
   * the print, after the print (and after a successful publish when publishing); withheld when every 1h quote failed or
   * is missing. Its failure never fails the hour.
   */
  ping?: () => Promise<boolean>;
  /**
   * The hourly verification reads (VERIFY_WALLETS_FILE; src/index/wallets.ts), run after the print, the publish and
   * the ping by the run that inserted the print, so they never delay them. Its failure is logged and never fails the hour.
   */
  readWallets?: (hour: number, now: Date) => Promise<{ read: number; failed: number }>;
  /** True when VERIFY_WALLETS_FILE is set but the reads were disabled at start-up (a bad file or VERIFY_RPS): each printed hour says so once. */
  verificationDisabled?: boolean;
  redact: (s: string) => string;
  /** Removes configured secret values only (redactConfiguredSecrets); quote sources then keep the endpoint path. Absent: sources keep only the host. */
  redactValues?: (s: string) => string;
  env: NodeJS.ProcessEnv;
  /**
   * Venues collected and stored but never counted in the print or published (src/index/gate.ts). Absent: every venue
   * in `venues` with a publish gate, so a caller that wires no gates publishes none of them.
   */
  collectOnly?: ReadonlySet<string>;
  log: (line: string) => void;
}

/** The hour's quotes the print may count and publish may carry. */
const countable = (d: HourDeps, quotes: readonly Quote[]): Quote[] => publishable(quotes, d.collectOnly ?? allGatedVenues(d.venues));

export interface HourResult {
  hour: number;
  /** True when this run inserted the print row. */
  printed: boolean;
  status: Print["status"] | null;
  /** The fee used as the normalisation ceiling; null on the no-op paths, where none was chosen. */
  energyFeeSun: number | null;
  failures: number;
  /** True when publish ran and succeeded, including the republish of a stored print on the no-op paths; false in collect-only mode and after a publish failure. */
  published: boolean;
}

/** Seed for the fee ceiling before the first successful chain read ever lands (the fee on 2026-10-22). */
export const SEED_ENERGY_FEE_SUN = 100;

const REDACTION_FAILED = "[redaction failed]";

/** Hours being run in this process; a second call for the same hour awaits the first. */
const inFlight = new Map<number, Promise<HourResult>>();

/**
 * One hour, start to finish, for a target hour the caller fixed: read the chain and the TRX price in parallel,
 * collect every venue in parallel, store every result and failure, print from the stored rows, insert the print
 * (a conflict means another run won and this one stops), then, only when this run inserted it, publish the files
 * and ping the dead-man monitor. The target hour is stamped on every row; the clock is only read for `readAt`
 * and the staleness rule.
 *
 * Within one process a second call for an hour already running awaits the first and returns its result. Across
 * processes (a deploy overlap) the unique print row decides, and because the print is computed from the stored
 * quotes (the first writer's rows win on conflict) every print is reproducible from its rows.
 *
 * A chain-table write failure is logged and never stops collection; a raw-payload write failure is logged and never stops the print. A publish failure is logged and reported as
 * `published: false` with no ping; the next hour's publish rewrites history.json from all prints and start-up
 * republishes, so a missed publish heals. A failed ping is logged and never fails the hour. The ping is withheld when every stored 1h quote is failed or missing, so a total collector outage trips the monitor. Failures of
 * insertQuotes and insertPrint reject, and the caller (the ticker) must catch.
 */
export function runHour(hour: number, d: HourDeps, now: Date = new Date()): Promise<HourResult> {
  const running = inFlight.get(hour);
  if (running) {
    safeLog(d, `hour ${hour}: already running in this process; waiting for it`);
    return running;
  }
  const tracked: Promise<HourResult> = runHourUnguarded(hour, d, now).finally(() => {
    if (inFlight.get(hour) === tracked) inFlight.delete(hour);
  });
  inFlight.set(hour, tracked);
  return tracked;
}

function safeLog(d: HourDeps, line: string): void {
  try {
    let out: string;
    try {
      const r = d.redact(line);
      out = typeof r === "string" ? r : REDACTION_FAILED;
    } catch {
      out = REDACTION_FAILED;
    }
    d.log(out);
  } catch {
    // a failing logger never fails the hour
  }
}

/**
 * On the no-op paths (the hour is already printed, here or by another process), rewrite the files from the stored
 * print and its stored quotes, so a process that started after the print (a deploy near :00, with a fresh disk)
 * still serves the latest hour. A run for an hour older than the newest print (a stalled or late run) does not
 * republish, so the page never rolls back. No ping: only the run that inserted the print pings. A failure is logged, never thrown.
 */
async function republishStored(hour: number, d: HourDeps, log: (line: string) => void): Promise<boolean> {
  if (!d.publish) return false;
  try {
    const newest = await lastPrint(d.sql);
    if (newest && newest.hour > hour) {
      log(`hour ${hour}: a later print exists; not republishing hour ${hour}`);
      return false;
    }
    const stored = await printForHour(d.sql, hour);
    if (!stored) return false;
    await d.publish(hour, stored, countable(d, await quotesForHour(d.sql, hour)));
    log(`hour ${hour}: republished the stored print`);
    return true;
  } catch (e) {
    log(`hour ${hour}: republishing the stored print failed: ${errorMessage(e)}`);
    return false;
  }
}

/** The hour without the in-process guard; exported so tests can stand in for a second process. */
export async function runHourUnguarded(hour: number, d: HourDeps, now: Date): Promise<HourResult> {
  const log = (line: string): void => safeLog(d, line);

  if (await hasPrint(d.sql, hour)) {
    log(`hour ${hour}: already printed; nothing to collect`);
    return { hour, printed: false, status: null, energyFeeSun: null, failures: 0, published: await republishStored(hour, d, log) };
  }

  const { energyFeeSun, trxUsd } = await readChainAndPrice(hour, d, now, log);
  const failures = await collectAndStore(hour, d, { hour, now, energyFeeSun, trxUsd, fetchOptions: d.fetchOptions, redact: d.redact, ...(d.redactValues ? { redactValues: d.redactValues } : {}), env: d.env }, log);

  // The print comes from the stored rows, not from memory: where another run's rows won a conflict, theirs count.
  const quotes = await quotesForHour(d.sql, hour);
  // Collect-only venues are stored above but never reach the print or the files; the ping still sees every venue.
  const shown = countable(d, quotes);
  // Taken after collection: print() must run with a `now` at or after the last readAt.
  const p = print(shown, { now: new Date(), hour });
  const inserted = await insertPrint(d.sql, p);
  if (!inserted) {
    log(`hour ${hour}: another run printed first; stopping`);
    return { hour, printed: false, status: null, energyFeeSun, failures, published: await republishStored(hour, d, log) };
  }
  log(`hour ${hour}: printed ${p.status} median=${p.median} live=${p.liveCount} depthAware=${p.depthAwareCount}`);

  let published = false;
  if (d.publish) {
    try {
      await d.publish(hour, p, shown);
      published = true;
    } catch (e) {
      log(`hour ${hour}: publish failed: ${errorMessage(e)}`);
    }
  }
  // After the print in collect-only mode, after a successful publish otherwise.
  if (d.publish ? published : true) await pingUnlessAllFailed(hour, d, quotes, log);
  // Last, so about a minute of paced wallet reads never holds up the print or the ping. Only the run that inserted the
  // print reads, so two overlapping processes do not both spend the TronGrid rate limit on the same hour.
  await readWalletsAfterPrint(hour, d, now, log);
  return { hour, printed: true, status: p.status, energyFeeSun, failures, published };
}

/**
 * Reads the chain parameters and the TRX price in parallel and stores the chain row. The energy fee is the chain's, or,
 * when the chain read fails, the newest fee stored for this hour or earlier, or SEED_ENERGY_FEE_SUN when none is stored.
 */
async function readChainAndPrice(hour: number, d: HourDeps, now: Date, log: (line: string) => void): Promise<{ energyFeeSun: number; trxUsd: number | null }> {
  const [chain, trx] = await Promise.all([d.readChain(hour, now), d.readTrxUsd ? d.readTrxUsd() : Promise.resolve(null)]);
  const trxUsd = trx && trx.ok ? trx.trxUsd : null;
  if (trx && !trx.ok) log(`hour ${hour}: coingecko failed: ${trx.reason}`);

  if (chain.ok) {
    try {
      await insertChain(d.sql, { ...chain.params, trxUsd });
    } catch (e) {
      log(`hour ${hour}: storing the chain row failed: ${errorMessage(e)}`);
    }
    return { energyFeeSun: chain.params.energyFeeSun, trxUsd };
  }
  let stored: { fee: number; hour: number } | null = null;
  try {
    stored = await lastEnergyFeeRow(d.sql, hour);
  } catch (e) {
    log(`hour ${hour}: reading the last stored energy fee failed: ${errorMessage(e)}`);
  }
  const energyFeeSun = stored?.fee ?? SEED_ENERGY_FEE_SUN;
  log(`hour ${hour}: chain read failed: ${chain.reason}; using ${stored ? `the energy fee stored for hour ${stored.hour}` : "the seed energy fee"} (${energyFeeSun} sun)`);
  return { energyFeeSun, trxUsd };
}

/** Collects every venue in parallel, stores the quotes and their raw payloads, logs each quote; returns how many failed. */
async function collectAndStore(hour: number, d: HourDeps, ctx: CollectContext, log: (line: string) => void): Promise<number> {
  const results = await Promise.all(d.venues.map((v) => collectAll(v, ctx)));
  const collected = results.flatMap((r) => r.quotes);
  await insertQuotes(d.sql, collected);
  // Payloads are evidence, not the index: a failed insert is logged and the hour goes on to print.
  try {
    await insertPayloads(d.sql, results.flatMap((r) => r.payloads));
  } catch (e) {
    log(`hour ${hour}: storing the raw payloads failed: ${errorMessage(e)}`);
  }
  for (const q of collected) log(`hour ${hour}: ${q.venue} ${q.size} ${q.term} ${q.status}${q.reason ? ` (${q.reason})` : ""}`);
  return collected.filter((q) => q.status === "failed").length;
}

/**
 * The dead-man ping, in both modes, so collect-only deployments are watched too. Almost every hour is no_index by design,
 * so a total collector outage prints (and publishes) like a quiet hour; the ping is withheld when every stored 1h quote
 * failed or is missing, so the monitor sees the outage. A failed or throwing ping is logged and never fails the hour.
 */
async function pingUnlessAllFailed(hour: number, d: HourDeps, quotes: readonly Quote[], log: (line: string) => void): Promise<void> {
  if (!d.ping) return;
  const allFailed = quotes.filter((q) => q.term === "1h").every((q) => q.status === "failed" || q.status === "missing");
  if (allFailed) {
    log(`hour ${hour}: ping withheld: every venue failed`);
    return;
  }
  let ok = false;
  try {
    ok = await d.ping();
  } catch (e) {
    log(`hour ${hour}: dead-man ping threw: ${errorMessage(e)}`);
  }
  if (!ok) log(`hour ${hour}: dead-man ping failed (the monitor will alert if this persists)`);
}

/** The hourly verification reads, when wired; their failure is logged and never fails the hour. */
async function readWalletsAfterPrint(hour: number, d: HourDeps, now: Date, log: (line: string) => void): Promise<void> {
  if (d.readWallets) {
    try {
      const w = await d.readWallets(hour, now);
      log(`hour ${hour}: verification reads ${w.read} ok, ${w.failed} failed`);
    } catch (e) {
      log(`hour ${hour}: verification reads failed: ${errorMessage(e)}`);
    }
  } else if (d.verificationDisabled) {
    log(`hour ${hour}: verification reads disabled (see start-up log)`);
  }
}
