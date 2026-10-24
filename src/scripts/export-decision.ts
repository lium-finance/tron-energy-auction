import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allPrints } from "../index/db.js";
import { redactSecrets } from "../index/redact.js";
import { loadWallets } from "../index/wallet-list.js";
import { bandFact } from "./band.js";
import { clearabilityDefaults, clearabilityFact, resolveInputs } from "./clearability.js";
import { assertNoAddresses, bandWindowFrom, decisionFiles, redactFiles, selectPrints, utcDate } from "./decision.js";
import { factEnv, loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { parseExportArgs } from "./export-args.js";
import { withDb } from "./io.js";
import { supplierFact, utilisationFact } from "./verify-facts.js";
import { writeRecord } from "./write-record.js";

/** docs/decisions at the repository root (the same from src/scripts under tsx and from dist/scripts once built); committed, not gitignored. */
const DEFAULT_OUT_DIR = fileURLToPath(new URL("../../docs/decisions", import.meta.url));

/**
 * `export-decision [from] [to] [--out <dir>] [--force] [--band-from <hour>]`: the decision record. The five facts (supplier,
 * utilisation, band with its term premium, clearability) are computed by the same functions as the verify-* scripts, each
 * over its own default window, except that --band-from judges the band over [hour, hour + 23] (the first day of collection, when the band sample is taken)
 * instead of the latest 24; decision.md states which. from and to (unix hours, inclusive) bound only the prints export (none:
 * every print; from alone: through the latest). prints.csv holds the prints as published (no price on a no_index or thin row).
 * Writes prints.csv, band.csv, facts.json and decision.md into `<out>/<UTC date>/` (default docs/decisions), every file
 * redacted and checked to hold no listed wallet address, and prints that directory. The files are written atomically
 * (a temporary directory renamed into place); an existing record of the same date, which may hold the hand-written
 * Decision line, is refused (exit 1) unless --force is given, and then kept as `<date>.replaced-<UTC timestamp>` beside the
 * new one (its path printed on a second line). Read-only on the database; needs
 * DATABASE_URL and VERIFY_WALLETS_FILE. Exit 2 for configuration or arguments, 1 otherwise.
 */
await runScript(async () => {
  loadDotEnv();
  const args = parseExportArgs(process.argv.slice(2));
  const env = factEnv();
  const wallets = loadWallets(env.walletsFile);
  const now = new Date();
  const files = await withDb(env.databaseUrl, async (sql) => {
    const supplier = await supplierFact(sql, wallets, null, now);
    const utilisation = await utilisationFact(sql, wallets, null, now);
    const band = await bandFact(sql, args.bandFrom === null ? null : bandWindowFrom(args.bandFrom), now);
    const defaults = await clearabilityDefaults(sql);
    const clearability = clearabilityFact(resolveInputs({}, defaults), defaults.window, now);
    const { prints, range } = selectPrints(await allPrints(sql), args);
    return redactFiles(decisionFiles({ supplier, utilisation, band, clearability }, prints, range, now, { bandFrom: args.bandFrom }));
  });
  assertNoAddresses(files, [...wallets.supplier, ...wallets.top100.wallets]);
  const { dir, replaced } = writeRecord(resolve(args.out ?? DEFAULT_OUT_DIR), utcDate(now), files, { force: args.force });
  console.log(redactSecrets(dir));
  if (replaced !== null) console.log(redactSecrets(`the replaced record is kept at ${replaced}`));
});
