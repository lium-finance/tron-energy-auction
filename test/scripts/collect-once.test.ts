import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/index/config.js";
import { createDb, type Sql } from "../../src/index/db.js";
import { runHour } from "../../src/index/hour.js";
import { runMigrations } from "../../src/index/migrate.js";
import { buildDeps } from "../../src/index/wire.js";
import { collectOnceDeps, runCollectOnce } from "../../src/scripts/collect-once-run.js";
import { testDbUrl as url } from "../index/testdb.js";

const PING = "https://hc-ping.test/collect-once-check";
const cfg: Config = { databaseUrl: "postgres://u:p@h/db", trongridApiKey: "k", publish: false, alertWebhookUrl: null, healthcheckPingUrl: PING, publicDir: "public", port: 3000, nettsApiKey: null, verifyWalletsFile: null, verifyRps: null };

describe("collectOnceDeps", () => {
  it("has no ping function whatever PUBLISH is, even with HEALTHCHECK_PING_URL set, and logs no ping line", () => {
    for (const publish of [false, true]) {
      const lines: string[] = [];
      const d = collectOnceDeps({ ...cfg, publish }, {} as Sql, {}, (l) => lines.push(l));
      expect(d.ping, `publish=${publish}`).toBeUndefined();
      expect(lines.filter((l) => l.includes("dead-man"))).toEqual([]);
    }
    expect(collectOnceDeps({ ...cfg, healthcheckPingUrl: null }, {} as Sql, {}, () => {}).ping).toBeUndefined();
  });
});

describe("buildDeps and the ping", () => {
  it("pings only when the caller asks for it (the service), and only the service says the ping is off", () => {
    expect(buildDeps(cfg, {} as Sql, {}, () => {}).ping).toBeUndefined();
    expect(typeof buildDeps(cfg, {} as Sql, {}, () => {}, { ping: true }).ping).toBe("function");
    const lines: string[] = [];
    buildDeps({ ...cfg, healthcheckPingUrl: null }, {} as Sql, {}, (l) => lines.push(l), { ping: true });
    expect(lines).toEqual(["start: outside dead-man ping off: HEALTHCHECK_PING_URL is not set"]);
    const quiet: string[] = [];
    buildDeps({ ...cfg, healthcheckPingUrl: null }, {} as Sql, {}, (l) => quiet.push(l));
    expect(quiet).toEqual([]);
  });
});

describe.skipIf(!url)("the collect-once code path against Postgres", () => {
  let sql: Sql;
  const tronsave = readFileSync(new URL("../fixtures/tronsave-20m-1h.json", import.meta.url), "utf8");
  const chainParams = readFileSync(new URL("../fixtures/trongrid-chainparameters.json", import.meta.url), "utf8");
  const accountResource = readFileSync(new URL("../fixtures/trongrid-accountresource.json", import.meta.url), "utf8");
  beforeAll(async () => {
    await runMigrations(url!);
    sql = createDb(url!);
    await sql`delete from quotes where hour between 7100 and 7199`;
    await sql`delete from prints where hour between 7100 and 7199`;
  });
  afterAll(async () => { await sql?.end(); });

  /** Every request made through the global fetch, answered from fixtures (a venue that prices, the chain) or 404. */
  function fakeNetwork() {
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(u);
      if (u.startsWith("https://api.tronsave.io/")) return new Response(tronsave, { status: 200 });
      if (u.endsWith("/wallet/getchainparameters")) return new Response(chainParams, { status: 200 });
      if (u.endsWith("/wallet/getaccountresource")) return new Response(accountResource, { status: 200 });
      return new Response("not here", { status: 404 });
    });
    return { urls, restore: () => spy.mockRestore() };
  }

  it("makes no ping request with PUBLISH off or on, while the service's deps do ping (the control)", async () => {
    const net = fakeNetwork();
    const quiet = { log: () => {} };
    try {
      // The control: the service's deps, same network, a fresh hour, ping the check.
      const service = await runHour(7100, buildDeps(cfg, sql, {}, quiet.log, { ping: true }));
      expect(service.printed).toBe(true);
      expect(net.urls.filter((u) => u === PING)).toHaveLength(1);
      net.urls.length = 0;

      for (const [hour, publish] of [[7101, false], [7102, true]] as const) {
        const r = await runCollectOnce(hour, { ...cfg, publish, publicDir: mkdtempSync(join(tmpdir(), "co-")) }, sql, {}, quiet.log);
        expect(r.printed, `hour ${hour}`).toBe(true);
      }
      expect(net.urls.some((u) => u.startsWith("https://api.tronsave.io/"))).toBe(true);
      expect(net.urls.filter((u) => u.includes("hc-ping"))).toEqual([]);
    } finally {
      net.restore();
    }
  });
});
