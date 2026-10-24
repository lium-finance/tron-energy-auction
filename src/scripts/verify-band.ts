import { BAND_WINDOW_HOURS } from "../core/pass.js";
import { bandFact } from "./band.js";
import { databaseEnv, loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { printJsonLine, withDb } from "./io.js";
import { parseRangeArgs } from "./verify-facts.js";

/**
 * `verify-band [from] [to]` (unix hours, inclusive; a from alone covers 24 hours; default the latest 24 stored hours with a
 * justlend-net row): the band fact and the per-venue term premium over stored quotes, as one JSON line on stdout. Errors go
 * to stderr (exit 2 for configuration or arguments, 1 otherwise). Read-only; needs only DATABASE_URL.
 */
await runScript(async () => {
  loadDotEnv();
  const range = parseRangeArgs(process.argv[2], process.argv[3], BAND_WINDOW_HOURS);
  printJsonLine(await withDb(databaseEnv().databaseUrl, (sql) => bandFact(sql, range)));
});
