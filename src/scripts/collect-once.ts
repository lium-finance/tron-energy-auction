import { loadConfig } from "../index/config.js";
import { SERVICE_POOL_SIZE } from "../index/db.js";
import { runMigrations } from "../index/migrate.js";
import { makeLog } from "../index/wire.js";
import { runCollectOnce } from "./collect-once-run.js";
import { loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { parseHourArg } from "./hour-arg.js";
import { printJsonLine, withDb } from "./io.js";

/**
 * One run of the hour job for the current hour (an argument must equal it). The job's log lines go to stderr, so stdout is
 * exactly one JSON line. It never pings the dead-man monitor (collect-once-run.ts).
 */
await runScript(async () => {
  loadDotEnv();
  const hour = parseHourArg(process.argv[2]);
  const cfg = loadConfig();
  await runMigrations(cfg.databaseUrl);
  const log = makeLog(process.env, process.stderr);
  printJsonLine(await withDb(cfg.databaseUrl, (sql) => runCollectOnce(hour, cfg, sql, process.env, log), SERVICE_POOL_SIZE));
});
