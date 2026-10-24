import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../core/errors.js";

export interface WriteRecordOptions {
  force: boolean;
  /** The moment in the replaced record's name; defaults to now. */
  now?: Date;
  /** Injected in tests to make a rename fail; defaults to renameSync. */
  rename?: (from: string, to: string) => void;
}

/** `<date>.replaced-<YYYYMMDDTHHMMSSZ>` in `out`, with `-2`, `-3`, ... when a forced run in the same second already took it. */
function replacedName(out: string, date: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const base = join(out, `${date}.replaced-${stamp}`);
  let path = base;
  for (let n = 2; existsSync(path); n++) path = `${base}-${n}`;
  return path;
}

/**
 * Writes the record's files into `<out>/<date>/` atomically: they are written into a temporary directory beside it
 * (`<out>/.<date>.tmp-*`, gitignored), which is then renamed into place, so a failure leaves no partial date directory.
 *
 * An existing `<out>/<date>/` may hold the hand-written Decision line, so it is never replaced unless `force` is set
 * (an Error, exit 1, otherwise). With `force`, the old directory is moved aside to `<out>/<date>.replaced-<UTC timestamp>`
 * and kept there, and the new one renamed in; if that rename fails, the old one is put back (if that fails too, the Error
 * names where the old record is and carries the first failure as its cause). Returns the date directory
 * and where the replaced record went (null when there was none).
 */
export function writeRecord(out: string, date: string, files: Readonly<Record<string, string>>, o: WriteRecordOptions): { dir: string; replaced: string | null } {
  const rename = o.rename ?? renameSync;
  const dir = join(out, date);
  if (existsSync(dir) && !o.force) throw new Error(`${dir} already exists and may hold the hand-written Decision line; pass --force to replace it`);
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(out, `.${date}.tmp-`));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(tmp, name), text);
    if (!existsSync(dir)) {
      rename(tmp, dir);
      return { dir, replaced: null };
    }
    const replaced = replacedName(out, date, o.now ?? new Date());
    rename(dir, replaced);
    try {
      rename(tmp, dir);
    } catch (e) {
      try {
        rename(replaced, dir);
      } catch (back) {
        const why = errorMessage(back);
        throw new Error(`the new record could not be renamed into ${dir}, and moving the old one back failed (${why}); the old record is at ${replaced}`, { cause: e });
      }
      throw e;
    }
    return { dir, replaced };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
