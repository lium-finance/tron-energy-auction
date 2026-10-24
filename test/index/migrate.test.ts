import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { testDbUrl as url } from "./testdb.js";

let sql: Sql;
beforeAll(() => { if (url) sql = createDb(url, 1); });
afterAll(async () => { await sql?.end(); });

describe.skipIf(!url)("runMigrations", () => {
  it("applies the file once when two runs start together on an empty schema", async () => {
    await sql`drop table if exists quotes, prints, chain, verification, payloads, alerts, schema_migrations`;
    const results = await Promise.all([runMigrations(url!), runMigrations(url!)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
    expect(results.flat()).toEqual(["001-initial.sql"]);
    const rows = await sql<{ name: string }[]>`select name from schema_migrations`;
    expect(rows.map((r) => r.name)).toEqual(["001-initial.sql"]);
    expect(await runMigrations(url!)).toEqual([]);
  });
});
