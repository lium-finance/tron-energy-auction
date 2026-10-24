import { ConfigError } from "../index/config.js";
import { flagValue, HOUR_ARG, shown } from "./args.js";

export interface ExportArgs {
  from: number | null;
  to: number | null;
  /** The --out directory; null for the default (docs/decisions at the repository root). */
  out: string | null;
  /** --force: replace an existing `<out>/<date>/`, which is kept beside it as `<date>.replaced-<UTC timestamp>`. */
  force: boolean;
  /** --band-from <hour>: judge the band over [hour, hour + 23] (bandWindowFrom); null keeps the latest-24 default. */
  bandFrom: number | null;
}

const OUT_FLAG = /^--out(?:=([\s\S]*))?$/;
const BAND_FROM_FLAG = /^--band-from(?:=([\s\S]*))?$/;

/**
 * `[from] [to] [--out <dir>] [--force] [--band-from <hour>]` (or `--out=<dir>`, `--band-from=<hour>`): from and to are unix
 * hours, inclusive, for the prints export. None: every stored print; from alone: from it through the latest print. --force
 * replaces an existing record of the same date. --band-from judges the band over the 24 hours from that hour. Anything
 * malformed, repeated or unknown is a ConfigError.
 */
export function parseExportArgs(argv: readonly string[]): ExportArgs {
  const hours: string[] = [];
  let out: string | null = null;
  let force = false;
  let bandFrom: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = arg.match(OUT_FLAG);
    const b = arg.match(BAND_FROM_FLAG);
    if (b) {
      const { value, last } = flagValue(argv, i, b[1]);
      i = last;
      if (value === undefined || !HOUR_ARG.test(value)) throw new ConfigError(`--band-from needs a unix hour; got "${shown(value ?? "")}"`);
      if (bandFrom !== null) throw new ConfigError("--band-from is given twice");
      bandFrom = Number(value);
    } else if (arg === "--force") {
      if (force) throw new ConfigError("--force is given twice");
      force = true;
    } else if (m) {
      const { value, last } = flagValue(argv, i, m[1]);
      i = last;
      if (value === undefined || value.trim() === "") throw new ConfigError("--out needs a directory");
      if (out !== null) throw new ConfigError("--out is given twice");
      out = value;
    } else if (arg.startsWith("-")) {
      throw new ConfigError(`unknown argument "${shown(arg)}"; use [from] [to] [--out <dir>] [--force] [--band-from <hour>]`);
    } else {
      hours.push(arg);
    }
  }
  if (hours.length > 2) throw new ConfigError(`at most two hours (from and to); got "${shown(hours[2]!)}"`);
  const hour = (name: string, a: string | undefined): number | null => {
    if (a === undefined) return null;
    if (!HOUR_ARG.test(a)) throw new ConfigError(`${name} must be a unix hour; got "${shown(a)}"`);
    return Number(a);
  };
  const from = hour("from", hours[0]);
  const to = hour("to", hours[1]);
  if (from !== null && to !== null && to < from) throw new ConfigError(`to (${to}) is before from (${from})`);
  return { from, to, out, force, bandFrom };
}
