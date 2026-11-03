import { NO_STORED_DEFAULTS, clearabilityDefaults, clearabilityFact, parseClearabilityArgs, resolveInputs, type Defaults } from "./clearability.js";
import { databaseEnv, loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { printJsonLine, withDb } from "./io.js";

/**
 * `verify-clearability [--net <sun>] [--dealer <sun>] [--burn <sun>]`: the paper clearing of one supplier against 2 and 3
 * bidders inside the band, as one JSON line on stdout. Each input defaults from the database (net and the cheapest depth-aware
 * quote from the latest hour that has both, the latest chain fee or 100); with all three flags given the database is not read.
 * No band in the stored rows is a result (pass false with a reason, exit 0). Errors go to stderr: exit 2 for configuration, a
 * malformed flag or a flag that breaks net < dealer <= burn, 1 otherwise. Needs only DATABASE_URL.
 * band-too-narrow is a result (exit 0) even when both inputs are flags; exit 2 means a flag broke net < dealer <= burn.
 */
await runScript(async () => {
  loadDotEnv();
  const flags = parseClearabilityArgs(process.argv.slice(2));
  const allFlagsGiven = flags.net !== undefined && flags.dealer !== undefined && flags.burn !== undefined;
  const defaults: Defaults = allFlagsGiven ? NO_STORED_DEFAULTS : await withDb(databaseEnv().databaseUrl, (sql) => clearabilityDefaults(sql));
  printJsonLine(clearabilityFact(resolveInputs(flags, defaults), defaults.window));
});
