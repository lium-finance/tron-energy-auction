import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireEnv } from "../index/config.js";

/**
 * Scripts run from a laptop: load `.env` at the repository root when it exists; Railway sets the variables itself.
 * Variables already in the environment win. `ENV_FILE` (or `path`) names another file; a file that does not exist is skipped.
 */
export function loadDotEnv(path: string = process.env.ENV_FILE ?? fileURLToPath(new URL("../../.env", import.meta.url))): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

/**
 * What the wallet fact scripts (verify-supplier, verify-utilisation, export-decision) need from the environment: only
 * DATABASE_URL and VERIFY_WALLETS_FILE. They read stored rows and never call an API, so unlike loadConfig they do not need
 * TRONGRID_API_KEY.
 */
export function factEnv(env: NodeJS.ProcessEnv = process.env): { databaseUrl: string; walletsFile: string } {
  return { databaseUrl: requireEnv(env, "DATABASE_URL"), walletsFile: requireEnv(env, "VERIFY_WALLETS_FILE") };
}

/** What the quote-based fact scripts (verify-band, verify-clearability) need: only DATABASE_URL; they need no wallet list. */
export function databaseEnv(env: NodeJS.ProcessEnv = process.env): { databaseUrl: string } {
  return { databaseUrl: requireEnv(env, "DATABASE_URL") };
}
