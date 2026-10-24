import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, redactDbUrl, type Sql } from "./db.js";
import { redactSecrets } from "./redact.js";
import { errorText } from "../core/errors.js";

const DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Applies every pending migrations/*.sql in name order inside ONE transaction that first takes a transaction-level
 * advisory lock, so two Railway instances starting at once cannot both apply a file. The lock is tied to
 * the transaction: released at commit or rollback, never left held by a dropped connection. The applied
 * list is read after the lock is held, so the second instance sees the first one's work and does nothing. A failure
 * rolls back every file and every schema_migrations row of the run.
 */
export async function runMigrations(url: string): Promise<string[]> {
  const sql: Sql = createDb(url, 1);
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('tron-energy-index-migrate'))`;
      await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
      const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
      const applied: string[] = [];
      for (const name of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(name)) continue;
        await tx.unsafe(readFileSync(DIR + name, "utf8"));
        await tx`insert into schema_migrations (name) values (${name})`;
        applied.push(name);
      }
      return applied;
    });
  } finally {
    await sql.end();
  }
}

/** True when this file is the process entry point, under both tsx and node, through symlinks. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}

if (isMain()) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  runMigrations(url).then(
    (applied) => console.log(`migrations applied on ${redactDbUrl(url)}: ${applied.length === 0 ? "none pending" : applied.join(", ")}`),
    (e: unknown) => { console.error(redactSecrets(errorText(e))); process.exit(1); },
  );
}
