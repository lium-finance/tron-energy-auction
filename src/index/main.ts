import { hourOf } from "../core/hour.js";
import { ConfigError, loadConfig } from "./config.js";
import { createDb, DB_END_TIMEOUT_S, SERVICE_POOL_SIZE, STATEMENT_TIMEOUT_MS } from "./db.js";
import { runHour } from "./hour.js";
import { runMigrations } from "./migrate.js";
import { redactSecrets } from "./redact.js";
import { runTick, shutdown, startTicks } from "./schedule.js";
import { startServer } from "./serve.js";
import { alertJob, buildDeps, makeLog, republish } from "./wire.js";
import { errorText } from "../core/errors.js";

/**
 * The process: config, migrations, republish (PUBLISH=on), the server (always, so /healthz answers), the current hour
 * once, then the :00 hour tick and the :05 alert tick (schedule.ts). SIGTERM and SIGINT shut down in order; a second
 * signal, an unhandled rejection or an uncaught exception exits 1.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = makeLog(process.env);
  log(`start: publish=${cfg.publish ? "on" : "off"} port=${cfg.port}`);

  const applied = await runMigrations(cfg.databaseUrl);
  log(`start: migrations ${applied.length === 0 ? "none pending" : `applied ${applied.join(", ")}`}`);
  const sql = createDb(cfg.databaseUrl, SERVICE_POOL_SIZE, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  // Only this long-running service pings the dead-man monitor; a manual collect-once from a laptop never does, or it
  // would tell the monitor the deployment is alive when it may not be.
  const deps = buildDeps(cfg, sql, process.env, log, { ping: true });
  log(`start: venues=${deps.venues.length}`);

  if (cfg.publish) {
    const hour = await republish(sql, cfg.publicDir, cfg.collectOnly);
    log(hour === null ? "start: no print yet; wrote the first-print page" : `start: republished hour ${hour}`);
  }
  // Always up, so the platform healthcheck has /healthz; with PUBLISH=off the file routes 404.
  const server = await startServer(cfg.publicDir, cfg.port);
  log(`start: serving ${cfg.publicDir} on :${server.port}${cfg.publish ? "" : " (healthz only until PUBLISH=on)"}`);

  const running = new Set<Promise<unknown>>();
  let ticks: { stop: () => void } | null = null;

  // Registered after start-up, which is safe: until here no job runs, migrations are one transaction and files are written atomically, so the default action (exit at once) loses nothing.
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log(`shutdown: ${signal} again during shutdown; exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    void shutdown(signal, {
      stopTicks: () => ticks?.stop(),
      closeServer: server.close,
      inFlight: () => Promise.allSettled([...running]),
      endDb: () => sql.end({ timeout: DB_END_TIMEOUT_S }),
      log,
    }).finally(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // A restart inside the hour prints once; on an hour already printed runHour republishes the stored print.
  void runTick("hour (start-up)", () => runHour(hourOf(new Date()), deps), { log, running });
  // The :05 job runs in both modes: the degraded-data alert matters most in the first days, when the band sample is collected with PUBLISH=off.
  ticks = startTicks({
    log,
    running,
    jobs: { hour: (hour) => runHour(hour, deps), alerts: (due) => alertJob(sql, cfg, log, { now: due }) },
  });
}

/** Never swallowed: a stray rejection or exception means the process state is unknown, so it is logged (redacted) and the process exits for the platform to restart. */
function fatal(kind: string): (e: unknown) => void {
  return (e: unknown) => {
    try {
      process.stderr.write(`${new Date().toISOString()} fatal: ${kind}: ${redactSecrets(errorText(e))}\n`);
    } finally {
      process.exit(1);
    }
  };
}
process.on("unhandledRejection", fatal("unhandled rejection"));
process.on("uncaughtException", fatal("uncaught exception"));

main().catch((e: unknown) => {
  process.stderr.write(`${redactSecrets(errorText(e))}\n`);
  process.exit(e instanceof ConfigError ? 2 : 1);
});
