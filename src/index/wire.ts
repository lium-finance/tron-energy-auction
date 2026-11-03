import { readChainParams } from "../collectors/chain.js";
import { readTrxUsd } from "../collectors/coingecko.js";
import { VENUES } from "../collectors/index.js";
import { PACED_FETCH_OPTIONS } from "../collectors/pace.js";
import type { ChainParams, Print, Quote } from "../core/types.js";
import { degradedCheck, pingHealthcheck, postAlert, thinShareCheck } from "./alert.js";
import { parseVerifyRps, type Config } from "./config.js";
import { allPrints, chainForHour, lastPrint, PAYLOAD_RETENTION_DAYS, prunePayloads, quotesForHour, type Sql } from "./db.js";
import type { HourDeps } from "./hour.js";
import { buildLatest, publishFiles, type ChainSummary } from "./publish.js";
import { allGatedVenues, publishable } from "./gate.js";
import { redactConfiguredSecrets, redactSecrets } from "./redact.js";
import { loadWallets } from "./wallet-list.js";
import { readWallets } from "./wallets.js";
import { errorText } from "../core/errors.js";

export const FETCH_OPTIONS = { budgetMs: 20_000, retryAtMs: 10_000 } as const;

/** One timestamped line on `stream` (stdout by default), redacted against `env` first. Never throws. */
export function makeLog(env: NodeJS.ProcessEnv, stream: Pick<NodeJS.WriteStream, "write"> = process.stdout): (line: string) => void {
  return (line: string): void => {
    try {
      stream.write(`${new Date().toISOString()} ${redactSecrets(line, env)}\n`);
    } catch {
      // a broken stdout must not take the job down
    }
  };
}

export function chainSummary(c: ChainParams | null): ChainSummary | null {
  return c ? { energyFeeSun: c.energyFeeSun, totalEnergyWeightTrx: c.totalEnergyWeightTrx, trxUsd: c.trxUsd } : null;
}

/** Writes the three files for one print: latest.json from the print, its stored quotes and its chain row; history.json from every print. */
export async function publishPrint(sql: Sql, dir: string, p: Print, quotes: readonly Quote[]): Promise<void> {
  const chain = await chainForHour(sql, p.hour);
  await publishFiles(dir, buildLatest(p, quotes, chainSummary(chain)), await allPrints(sql));
}

/**
 * Start-up with PUBLISH=on: Railway's disk is replaced on every deploy, so the files are rebuilt from the last print
 * row before serving. With no print row yet, the page says when the first print is due and latest.json is absent.
 * Returns the hour republished, or null for the first-print page. Collect-only venues' quotes are left out of
 * latest.json, as the hour job leaves them out (`collectOnly` defaults to every gated venue).
 */
export async function republish(sql: Sql, dir: string, collectOnly: ReadonlySet<string> = allGatedVenues()): Promise<number | null> {
  const last = await lastPrint(sql);
  if (!last) {
    await publishFiles(dir, null, []);
    return null;
  }
  await publishPrint(sql, dir, last, publishable(await quotesForHour(sql, last.hour), collectOnly));
  return last.hour;
}

/** The environment the collectors see: only the NetTS key, when there is one; nothing else from the process environment reaches them. */
export function venueEnv(nettsApiKey: string | null | undefined): NodeJS.ProcessEnv {
  return nettsApiKey ? { NETTS_API_KEY: nettsApiKey } : {};
}

export interface BuildDepsOptions {
  /**
   * Wire the dead-man ping. Only the service (main.ts) sets it: a ping from any other process, such as a manual
   * collect-once, would tell the monitor the deployment is alive when it may not be. Default false.
   */
  ping?: boolean;
}

/** `log` defaults to makeLog(env) on stdout; a script that prints a result on stdout passes a stderr logger. */
export function buildDeps(cfg: Config, sql: Sql, env: NodeJS.ProcessEnv, log: (line: string) => void = makeLog(env), o: BuildDepsOptions = {}): HourDeps {
  const redact = (s: string): string => redactSecrets(s, env);
  const deps: HourDeps = {
    sql,
    venues: VENUES,
    readChain: (hour, now) => readChainParams({ hour, now, apiKey: cfg.trongridApiKey, fetchOptions: FETCH_OPTIONS, redact }),
    readTrxUsd: () => readTrxUsd(FETCH_OPTIONS),
    fetchOptions: FETCH_OPTIONS,
    redact,
    redactValues: (s) => redactConfiguredSecrets(s, env),
    env: venueEnv(cfg.nettsApiKey),
    collectOnly: cfg.collectOnly,
    log,
  };
  if (cfg.verifyWalletsFile) {
    // Checked once at start-up. A bad wallets file or VERIFY_RPS logs one line and leaves only the verification reads off:
    // the index itself still starts and prints.
    try {
      const wallets = loadWallets(cfg.verifyWalletsFile);
      const rps = parseVerifyRps(cfg.verifyRps ?? undefined);
      deps.readWallets = (hour, now) => readWallets(sql, wallets, { hour, now, apiKey: cfg.trongridApiKey, fetchOptions: PACED_FETCH_OPTIONS, redact }, log, { rps });
    } catch (e) {
      log(`start: verification reads disabled: ${errorText(e)}`);
      deps.verificationDisabled = true;
    }
  }
  if (cfg.publish) deps.publish = (_hour, p, quotes) => publishPrint(sql, cfg.publicDir, p, quotes);
  // For the service only: the dead-man ping runs whenever its URL is set, in collect-only mode too, so a deployment that
  // only collects is watched as well. loadConfig
  // requires the URL when PUBLISH=on.
  if (o.ping) {
    if (cfg.healthcheckPingUrl) {
      const url = cfg.healthcheckPingUrl;
      deps.ping = () => pingHealthcheck(url, fetch, log);
    } else {
      log("start: outside dead-man ping off: HEALTHCHECK_PING_URL is not set");
    }
  }
  return deps;
}

export interface AlertJobOptions {
  now?: Date;
  /** Defaults to postAlert to ALERT_WEBHOOK_URL (printed only when it is unset). */
  send?: (text: string) => Promise<boolean>;
  /** The two checks; injectable for tests. */
  checks?: { thinShare: typeof thinShareCheck; degraded: typeof degradedCheck };
  /** The raw-payload retention; injectable for tests. */
  prune?: (sql: Sql, now: Date) => Promise<number>;
}

/**
 * The :05 job: the thin-share check and the degraded-data check, both through the same webhook. Each runs even
 * when the other throws; a failure is logged, and the job rejects afterwards so the ticker records it.
 * Beside them, the raw-payload retention deletes payloads older than 30 days. It has its own error handling:
 * its failure is logged and neither blocks the alerts nor rejects the job.
 */
export async function alertJob(sql: Sql, cfg: Config, log: (line: string) => void, o: AlertJobOptions = {}): Promise<void> {
  const now = o.now ?? new Date();
  const send = o.send ?? ((text: string) => postAlert(cfg.alertWebhookUrl, text));
  const checks = o.checks ?? { thinShare: thinShareCheck, degraded: degradedCheck };
  const prune = o.prune ?? prunePayloads;
  const retention = (async () => {
    try {
      log(`payloads: deleted ${await prune(sql, now)} older than ${PAYLOAD_RETENTION_DAYS} days`);
    } catch (e) {
      log(`payloads: retention failed: ${errorText(e)}`);
    }
  })();
  const [thin, degraded] = await Promise.allSettled([checks.thinShare(sql, send, now), checks.degraded(sql, send, now)]);
  await retention;
  const failed: string[] = [];
  if (thin.status === "fulfilled") {
    log(`alerts: thin share ${Math.round(thin.value.share * 100)} %${thin.value.sent ? ", alert sent" : ""}`);
  } else {
    failed.push("thin-share");
    log(`alerts: thin-share check failed: ${errorText(thin.reason)}`);
  }
  if (degraded.status === "fulfilled") {
    log(`alerts: degraded ${degraded.value.degraded.length === 0 ? "none" : degraded.value.degraded.join("; ")}${degraded.value.sent ? ", alert sent" : ""}`);
  } else {
    failed.push("degraded");
    log(`alerts: degraded check failed: ${errorText(degraded.reason)}`);
  }
  if (failed.length > 0) throw new Error(`alert checks failed: ${failed.join(", ")}`);
}
