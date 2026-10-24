import { createDb, DB_END_TIMEOUT_S, STATEMENT_TIMEOUT_MS, type Sql } from "../index/db.js";
import { redactSecrets } from "../index/redact.js";

/**
 * Opens a pool of `max` connections (one for the read-only fact scripts) with the server-side statement timeout, runs
 * `fn` with it, and closes the pool whether `fn` resolves or throws.
 */
export async function withDb<T>(url: string, fn: (sql: Sql) => Promise<T>, max = 1): Promise<T> {
  const sql = createDb(url, max, { statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: DB_END_TIMEOUT_S });
  }
}

/** A script's result: `value` as one JSON line on stdout, with every secret removed. */
export function printJsonLine(value: unknown): void {
  console.log(redactSecrets(JSON.stringify(value)));
}
