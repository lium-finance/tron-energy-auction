import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { METHOD_VERSION, type Print, type Quote } from "../../src/core/types.js";
import type { Config } from "../../src/index/config.js";
import { createDb, insertChain, insertPrint, insertQuotes, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { alertJob, buildDeps, republish } from "../../src/index/wire.js";
import { testDbUrl as url } from "./testdb.js";

const cfg: Config = { databaseUrl: "postgres://u:p@h/db", trongridApiKey: "k", publish: false, alertWebhookUrl: null, healthcheckPingUrl: null, publicDir: "public", port: 3000, nettsApiKey: null, verifyWalletsFile: null, verifyRps: null };

describe("buildDeps", () => {
  it("for the service: leaves publish absent in collect-only mode, and ping too when no ping URL is set, saying so once at start-up", () => {
    const lines: string[] = [];
    const d = buildDeps(cfg, {} as never, {}, (l) => lines.push(l), { ping: true });
    expect(d.publish).toBeUndefined();
    expect(d.ping).toBeUndefined();
    expect(lines).toEqual(["start: outside dead-man ping off: HEALTHCHECK_PING_URL is not set"]);
  });
  it("for the service: wires the ping in collect-only mode when the ping URL is set, and says nothing about it", () => {
    const lines: string[] = [];
    const d = buildDeps({ ...cfg, healthcheckPingUrl: "https://hc-ping.com/x" }, {} as never, {}, (l) => lines.push(l), { ping: true });
    expect(d.publish).toBeUndefined();
    expect(typeof d.ping).toBe("function");
    expect(lines).toEqual([]);
    expect(d.venues.map((v) => v.venue)).toEqual(["tronsave", "tronbid", "getblock", "netts", "justlend", "justlend-net"]);
  });
  it("wires publish when PUBLISH is on, and the ping only when the caller is the service", () => {
    const d = buildDeps({ ...cfg, publish: true, healthcheckPingUrl: "https://hc-ping.com/x" }, {} as never, {}, () => {}, { ping: true });
    expect(typeof d.publish).toBe("function");
    expect(typeof d.ping).toBe("function");
    expect(buildDeps({ ...cfg, publish: true, healthcheckPingUrl: "https://hc-ping.com/x" }, {} as never, {}, () => {}).ping).toBeUndefined();
  });
  it("passes only the NetTS key to the collectors, and only when it is set", () => {
    expect(buildDeps(cfg, {} as never, { TRONGRID_API_KEY: "abcdefghijkl" }, () => {}).env).toEqual({});
    expect(buildDeps({ ...cfg, nettsApiKey: "netts-key-123" }, {} as never, { TRONGRID_API_KEY: "abcdefghijkl" }, () => {}).env).toEqual({ NETTS_API_KEY: "netts-key-123" });
  });
  it("wires readWallets only when VERIFY_WALLETS_FILE is set", () => {
    expect(buildDeps(cfg, {} as never, {}, () => {}).readWallets).toBeUndefined();
    const example = new URL("../../docs/verification/wallets.example.json", import.meta.url).pathname;
    const lines: string[] = [];
    expect(typeof buildDeps({ ...cfg, verifyWalletsFile: example, verifyRps: "3" }, {} as never, {}, (l) => lines.push(l)).readWallets).toBe("function");
    expect(lines.filter((l) => l.includes("verification"))).toEqual([]);
    expect(buildDeps(cfg, {} as never, {}, () => {}).verificationDisabled).toBeUndefined();
  });
  it("a malformed wallets file or a bad VERIFY_RPS logs one line and disables only the verification reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallets-"));
    writeFileSync(join(dir, "w.json"), '{"supplier":["x"]}');
    const lines: string[] = [];
    const d = buildDeps({ ...cfg, publish: true, healthcheckPingUrl: "https://hc-ping.com/x", verifyWalletsFile: join(dir, "w.json") }, {} as never, {}, (l) => lines.push(l));
    expect(d.readWallets).toBeUndefined();
    expect(d.verificationDisabled).toBe(true);
    expect(typeof d.publish).toBe("function");
    expect(d.venues.length).toBeGreaterThan(0);
    expect(lines).toEqual(["start: verification reads disabled: ConfigError: supplier[0] is not a Tron address"]);
    const example = new URL("../../docs/verification/wallets.example.json", import.meta.url).pathname;
    const lines2: string[] = [];
    expect(buildDeps({ ...cfg, healthcheckPingUrl: "https://hc-ping.com/x", verifyWalletsFile: example, verifyRps: "50" }, {} as never, {}, (l) => lines2.push(l)).readWallets).toBeUndefined();
    expect(lines2).toEqual(["start: verification reads disabled: ConfigError: VERIFY_RPS must be a whole number from 1 to 10"]);
  });
  it("redacts against the environment it was given", () => {
    const d = buildDeps(cfg, {} as never, { TRONGRID_API_KEY: "abcdefghijkl" }, () => {});
    expect(d.redact("key abcdefghijkl")).toBe("key [redacted]");
  });
  it("gives the collectors a value-only redactor over the whole environment, so a source keeps its path but never a key", () => {
    const d = buildDeps(cfg, {} as never, { TRONGRID_API_KEY: "abcdefghijkl" }, () => {});
    expect(d.redactValues!("https://api.venue.test/v2/abcdefghijkl/q")).toBe("https://api.venue.test/v2/[redacted]/q");
    expect(d.redactValues!("https://api.venue.test/v2/estimate")).toBe("https://api.venue.test/v2/estimate");
  });
});

describe("alertJob", () => {
  it("runs both the thin-share and the degraded check, through one send", async () => {
    const sent: string[] = [];
    const send = async (t: string) => { sent.push(t); return true; };
    const thinShare = vi.fn(async (_sql: Sql, s: (t: string) => Promise<boolean>, _now?: Date) => { await s("thin"); return { share: 0.5, sent: true }; });
    const degraded = vi.fn(async (_sql: Sql, s: (t: string) => Promise<boolean>, _now?: Date) => { await s("degraded"); return { degraded: ["x"], sent: true }; });
    const now = new Date("2026-10-28T14:05:00Z");
    await alertJob({} as never, cfg, () => {}, { now, send, checks: { thinShare, degraded }, prune: async () => 0 });
    expect(thinShare).toHaveBeenCalledTimes(1);
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(thinShare.mock.calls[0]![2]).toBe(now);
    expect(degraded.mock.calls[0]![2]).toBe(now);
    expect(sent.sort()).toEqual(["degraded", "thin"]);
  });
  it("still runs the degraded check when the thin-share check throws, then rejects", async () => {
    const lines: string[] = [];
    const degraded = vi.fn(async () => ({ degraded: [], sent: false }));
    const thinShare = vi.fn(async () => { throw new Error("statement timeout"); });
    await expect(alertJob({} as never, cfg, (l) => lines.push(l), { checks: { thinShare, degraded }, prune: async () => 0 })).rejects.toThrow("thin-share");
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes("thin-share check failed: Error: statement timeout"))).toBe(true);
  });
  it("deletes payloads older than 30 days at :05 with its own error handling: a failure is logged and the alerts still run", async () => {
    const lines: string[] = [];
    const thinShare = vi.fn(async () => ({ share: 0, sent: false }));
    const degraded = vi.fn(async () => ({ degraded: [], sent: false }));
    const now = new Date("2026-10-28T14:05:00Z");
    const prune = vi.fn(async (_sql: Sql, _now: Date) => 3);
    await alertJob({} as never, cfg, (l) => lines.push(l), { now, checks: { thinShare, degraded }, prune });
    expect(prune.mock.calls[0]![1]).toBe(now);
    expect(lines).toContain("payloads: deleted 3 older than 30 days");
    const failing = vi.fn(async () => { throw new Error("statement timeout"); });
    const lines2: string[] = [];
    await expect(alertJob({} as never, cfg, (l) => lines2.push(l), { now, checks: { thinShare, degraded }, prune: failing })).resolves.toBeUndefined();
    expect(thinShare).toHaveBeenCalledTimes(2);
    expect(degraded).toHaveBeenCalledTimes(2);
    expect(lines2).toContain("payloads: retention failed: Error: statement timeout");
  });
  it("sends to the configured webhook by default", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const thinShare = vi.fn(async (_sql: Sql, s: (t: string) => Promise<boolean>) => ({ share: 0, sent: await s("hello") }));
      const degraded = vi.fn(async () => ({ degraded: [], sent: false }));
      await alertJob({} as never, { ...cfg, alertWebhookUrl: "https://hooks.test/x" }, () => {}, { checks: { thinShare, degraded }, prune: async () => 0 });
      expect(f).toHaveBeenCalledTimes(1);
      expect(f.mock.calls[0]![0]).toBe("https://hooks.test/x");
      expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({ text: "hello" });
    } finally {
      f.mockRestore();
      err.mockRestore();
    }
  });
});

describe.skipIf(!url)("publish wiring against Postgres", () => {
  let sql: Sql;
  beforeAll(async () => { await runMigrations(url!); sql = createDb(url!, 4, { statementTimeoutMs: 30_000 }); await sql`truncate quotes, prints, chain, alerts`; });
  afterAll(async () => { await sql?.end(); });

  const hour = 498_110;
  const p: Print = { hour, median: null, cheapest: null, dearest: null, liveCount: 1, depthAwareCount: 1, status: "no_index", methodVersion: METHOD_VERSION, printedAt: new Date("2026-10-28T14:00:20Z") };
  const q: Quote = { hour, venue: "tronsave", size: 20_000_000, term: "1h", sunPerUnit: 60.5, depth: 20_000_000, readAt: new Date("2026-10-28T14:00:12Z"), source: "https://v.test/q", status: "ok", reason: null, payloadHash: null };

  it("applies the statement timeout to the pool", async () => {
    const [row] = await sql<{ statement_timeout: string }[]>`show statement_timeout`;
    expect(row!.statement_timeout).toBe("30s");
  });

  it("writes the first-print page with no latest.json when nothing is printed yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wire-first-"));
    writeFileSync(join(dir, "latest.json"), "{}");
    expect(await republish(sql, dir)).toBeNull();
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("First print at");
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))).toEqual([]);
    expect(existsSync(join(dir, "latest.json"))).toBe(false);
  });

  it("deps.publish writes the three files from a stored print, its quotes and its chain row", async () => {
    await insertQuotes(sql, [q]);
    await insertChain(sql, { hour, energyFeeSun: 100, totalEnergyWeightTrx: 19_000_000_000, totalEnergyLimit: 180_000_000_000, trxUsd: 0.33, readAt: new Date("2026-10-28T14:00:05Z") });
    expect(await insertPrint(sql, p)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "wire-pub-"));
    const d = buildDeps({ ...cfg, publish: true, healthcheckPingUrl: "https://hc-ping.com/x", publicDir: dir }, sql, {});
    await d.publish!(hour, p, [q]);
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    expect(latest).toMatchObject({ hour, print: { status: "no_index", median: null }, chain: { energyFeeSun: 100, totalEnergyWeightTrx: 19_000_000_000, trxUsd: 0.33 } });
    expect(latest.quotes).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8")).map((r: { hour: number }) => r.hour)).toEqual([hour]);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("No index this hour");
  });

  it("republishes the last print row on start-up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wire-re-"));
    expect(await republish(sql, dir)).toBe(hour);
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    expect(latest).toMatchObject({ hour, chain: { energyFeeSun: 100 } });
    expect(latest.quotes.map((x: { venue: string }) => x.venue)).toEqual(["tronsave"]);
    expect(existsSync(join(dir, "history.json"))).toBe(true);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
  });
});
