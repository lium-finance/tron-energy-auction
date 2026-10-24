import { hourOf } from "../core/hour.js";
import { ConfigError } from "../index/config.js";
import { shown } from "./args.js";

/**
 * The unix hour collect-once runs: always the current one. Quotes are read now and stamped with the hour, so another
 * hour would mislabel the data (a past hour) or block the real print (a future one). An argument is accepted only
 * when it equals the current hour; anything else is a ConfigError (exit code 2). The message echoes at most 40 characters of the input.
 */
export function parseHourArg(arg: string | undefined, now: Date = new Date()): number {
  const current = hourOf(now);
  if (arg === undefined) return current;
  if (!/^\d+$/.test(arg) || Number(arg) !== current) {
    throw new ConfigError(`collect-once only collects the current hour (${current}); quotes are read now and stamped with the hour; got "${shown(arg)}"`);
  }
  return current;
}
