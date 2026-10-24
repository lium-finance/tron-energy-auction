import { loadWallets } from "../index/wallet-list.js";
import { factEnv, loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { printJsonLine, withDb } from "./io.js";
import { parseRangeArgs, utilisationFact } from "./verify-facts.js";

/**
 * `verify-utilisation [from] [to]` (unix hours, inclusive; default the latest 27 stored hours): the utilisation fact over the
 * per-wallet, per-hour rows in `verification`, as one JSON line on stdout. Errors go to stderr (exit 2 for configuration
 * or arguments, 1 otherwise). Read-only: it never writes and never calls an API, so it needs only DATABASE_URL and
 * VERIFY_WALLETS_FILE.
 */
await runScript(async () => {
  loadDotEnv();
  const range = parseRangeArgs(process.argv[2], process.argv[3]);
  const env = factEnv();
  const wallets = loadWallets(env.walletsFile);
  printJsonLine(await withDb(env.databaseUrl, (sql) => utilisationFact(sql, wallets, range)));
});
