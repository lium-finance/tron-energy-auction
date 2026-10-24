/** Helpers every script's argument parser shares. */

/** Longest stretch of an argument an error message echoes, so a pasted secret or a huge value is never printed in full. */
const SHOWN_CHARS = 40;

/** An argument as an error message may echo it: at most SHOWN_CHARS characters, then "...". */
export function shown(arg: string): string {
  return arg.length > SHOWN_CHARS ? `${arg.slice(0, SHOWN_CHARS)}...` : arg;
}

/** A unix hour given on the command line: digits only, at most nine of them. */
export const HOUR_ARG = /^\d{1,9}$/;

/**
 * The value of the flag at `argv[i]`, written `--name value` or `--name=value`. `inline` is the text after `=`, or undefined
 * when there was no `=`, in which case the value is the next argument. Returns the value (undefined when the flag comes
 * last with nothing after it) and the index of the last argument the flag used, for the caller's loop to continue from.
 */
export function flagValue(argv: readonly string[], i: number, inline: string | undefined): { value: string | undefined; last: number } {
  return inline !== undefined ? { value: inline, last: i } : { value: argv[i + 1], last: i + 1 };
}
