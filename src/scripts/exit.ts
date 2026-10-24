import { ConfigError } from "../index/config.js";
import { redactSecrets } from "../index/redact.js";
import { errorText } from "../core/errors.js";

/** 2 for a configuration or usage error (a ConfigError), 1 for anything else. */
export function exitCodeFor(e: unknown): 1 | 2 {
  return e instanceof ConfigError ? 2 : 1;
}

/** The one line a failing script prints to stderr: name and message, with every secret removed. Never throws. */
export function errorLine(e: unknown, env: NodeJS.ProcessEnv = process.env): string {
  let text: string;
  try {
    text = errorText(e);
  } catch {
    text = "unprintable error";
  }
  return redactSecrets(text, env).replace(/\s+/g, " ").trim();
}

/** Runs a script's main function: on failure prints a redacted one-line error and sets the exit code, never calling process.exit so open output is flushed. */
export async function runScript(main: () => Promise<number | void>): Promise<void> {
  try {
    const code = await main();
    if (code) process.exitCode = code;
  } catch (e) {
    process.stderr.write(`${errorLine(e)}\n`);
    process.exitCode = exitCodeFor(e);
  }
}
