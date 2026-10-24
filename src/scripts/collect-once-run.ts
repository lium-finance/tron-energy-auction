import type { Config } from "../index/config.js";
import type { Sql } from "../index/db.js";
import { runHour, type HourDeps, type HourResult } from "../index/hour.js";
import { buildDeps } from "../index/wire.js";

/**
 * collect-once's deps: the service's, with no dead-man ping, whatever PUBLISH and HEALTHCHECK_PING_URL say. A manual run
 * (from a laptop whose .env sets the ping URL, say) must never tell the monitor the deployed process is alive.
 */
export function collectOnceDeps(cfg: Config, sql: Sql, env: NodeJS.ProcessEnv, log: (line: string) => void): HourDeps {
  const deps = buildDeps(cfg, sql, env, log);
  delete deps.ping;
  return deps;
}

/** The collect-once code path: one run of the hour job for `hour` with collectOnceDeps. */
export function runCollectOnce(hour: number, cfg: Config, sql: Sql, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<HourResult> {
  return runHour(hour, collectOnceDeps(cfg, sql, env, log));
}
