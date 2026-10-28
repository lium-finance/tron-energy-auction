import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { VenueAdapter } from "../../src/collectors/adapter.js";
import { print as makePrint } from "../../src/core/print.js";
import { allPrints, chainForHour, createDb, hasPrint, insertChain, insertQuotes, quotesForHour, type Sql } from "../../src/index/db.js";
import { runHour, runHourUnguarded, type HourDeps } from "../../src/index/hour.js";
import { runMigrations } from "../../src/index/migrate.js";
import { testDbUrl as url } from "./testdb.js";

let sql: Sql;
beforeAll(async () => { if (!url) return; await runMigrations(url); sql = createDb(url); await sql`truncate quotes, prints, chain, verification, payloads, alerts`; });
afterAll(async () => { await sql?.end(); });

/** A venue that answers 40 sun with full depth for its one request. */
const venue = (name: string): VenueAdapter => ({
  venue: name,
  requests: [{ size: 20_000_000, term: "1h" }],
  request: () => ({ url: `https://${name}.test/q`, init: {} }),
  parse: () => ({ raw: { kind: "sunPerUnit", value: 40, term: "1h" }, depth: 20_000_000 }),
});

function deps(over: Partial<HourDeps> = {}): HourDeps {
  const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  return {
    sql,
    venues: [venue("a"), venue("b"), venue("c")],
    readChain: async (hour) => ({ ok: true, params: { hour, energyFeeSun: 100, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: 0.33, readAt: new Date() } }),
    fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl },
    publish: vi.fn(async () => {}),
    ping: vi.fn(async () => true),
    redact: (s) => s,
    env: {},
    log: () => {},
    ...over,
  };
}

describe.skipIf(!url)("runHour", () => {
  it("collects, prints, publishes and pings for its target hour", async () => {
    const d = deps();
    const r = await runHour(1000, d, new Date("2026-10-28T14:00:03Z"));
    expect(r).toMatchObject({ hour: 1000, printed: true, status: "live" });
    expect((await quotesForHour(sql, 1000)).map((q) => q.venue)).toEqual(["a", "b", "c"]);
    expect(d.publish).toHaveBeenCalledTimes(1);
    expect(d.ping).toHaveBeenCalledTimes(1);
  });
  it("is a no-op for an hour already printed: no collection, no ping, but the stored print is republished", async () => {
    const readChain = vi.fn(async (hour: number) => ({ ok: true as const, params: { hour, energyFeeSun: 100, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() } }));
    const d = deps({ readChain });
    const r = await runHour(1000, d, new Date("2026-10-28T14:30:00Z"));
    expect(r).toMatchObject({ hour: 1000, printed: false, energyFeeSun: null, published: true });
    expect(d.ping).not.toHaveBeenCalled();
    expect(readChain).not.toHaveBeenCalled();
    const stored = (await allPrints(sql)).find((p) => p.hour === 1000)!;
    expect(d.publish).toHaveBeenCalledTimes(1);
    expect(d.publish).toHaveBeenCalledWith(1000, stored, await quotesForHour(sql, 1000));
  });
  it("does not republish on the no-op path in collect-only mode", async () => {
    const d = deps({ publish: undefined, ping: undefined });
    const r = await runHour(1000, d);
    expect(r).toMatchObject({ hour: 1000, printed: false, published: false });
  });
  it("logs a failed republish on the no-op path and never throws", async () => {
    const lines: string[] = [];
    const d = deps({ publish: vi.fn(async () => { throw new Error("disk full"); }), log: (l) => lines.push(l) });
    const r = await runHour(1000, d);
    expect(r).toMatchObject({ printed: false, published: false });
    expect(lines.some((l) => l.includes("republishing the stored print failed: disk full"))).toBe(true);
    expect(d.ping).not.toHaveBeenCalled();
  });
  it("stamps the target hour on every quote even when the clock crosses the hour mid-run", async () => {
    const d = deps({ venues: [venue("slow")], fetchOptions: { budgetMs: 2000, retryAtMs: 1500, fetchImpl: (async () => { await new Promise((r) => setTimeout(r, 50)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch } });
    await runHour(1001, d, new Date("2026-10-28T14:59:59.990Z"));
    expect((await quotesForHour(sql, 1001)).every((q) => q.hour === 1001)).toBe(true);
    expect((await allPrints(sql)).map((p) => p.hour)).toEqual([1000, 1001]);
  });
  it("two overlapping processes (no in-process guard) leave one print and one set of quotes", async () => {
    const d1 = deps();
    const d2 = deps();
    const now = new Date();
    await Promise.all([runHourUnguarded(1002, d1, now), runHourUnguarded(1002, d2, now)]);
    expect((await allPrints(sql)).filter((p) => p.hour === 1002)).toHaveLength(1);
    expect(await quotesForHour(sql, 1002)).toHaveLength(3);
    expect(((d1.ping as ReturnType<typeof vi.fn>).mock.calls.length) + ((d2.ping as ReturnType<typeof vi.fn>).mock.calls.length)).toBe(1);
    // The loser of the race republishes the winner's print, so both processes serve the same hour.
    expect((d1.publish as ReturnType<typeof vi.fn>).mock.calls.length + (d2.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
  it("still prints when every venue failed and when the chain read failed (fee from the last stored row)", async () => {
    const d = deps({ venues: [{ ...venue("x"), parse: () => { throw new Error("drift"); } }], readChain: async () => ({ ok: false, reason: "403" }) });
    const r = await runHour(1003, d);
    expect(r).toMatchObject({ printed: true, status: "no_index", energyFeeSun: 100 });
  });
  it("withholds the ping (and says so) when every 1h quote failed, but still publishes", async () => {
    const lines: string[] = [];
    const d = deps({ venues: [{ ...venue("x"), parse: () => { throw new Error("drift"); } }, { ...venue("y"), parse: () => { throw new Error("drift"); } }], log: (l) => lines.push(l) });
    const r = await runHour(1010, d);
    expect(r).toMatchObject({ printed: true, status: "no_index", published: true });
    expect(d.publish).toHaveBeenCalledTimes(1);
    expect(d.ping).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("ping withheld: every venue failed"))).toBe(true);
  });
  it("still pings when only some venues failed", async () => {
    const d = deps({ venues: [venue("a"), { ...venue("x"), parse: () => { throw new Error("drift"); } }] });
    await runHour(1011, d);
    expect(d.ping).toHaveBeenCalledTimes(1);
  });
  it("in collect-only mode writes rows and does not publish, and without a ping URL does not ping", async () => {
    const d = deps({ publish: undefined, ping: undefined });
    const r = await runHour(1004, d);
    expect(r).toMatchObject({ printed: true, published: false });
    expect((await quotesForHour(sql, 1004)).length).toBe(3);
  });
  it("in collect-only mode pings after the print when a ping URL is set", async () => {
    const d = deps({ publish: undefined });
    const r = await runHour(1012, d);
    expect(r).toMatchObject({ printed: true, published: false });
    expect(d.ping).toHaveBeenCalledTimes(1);
  });
  it("in collect-only mode withholds the ping when every venue failed", async () => {
    const lines: string[] = [];
    const d = deps({ publish: undefined, venues: [{ ...venue("x"), parse: () => { throw new Error("drift"); } }], log: (l) => lines.push(l) });
    const r = await runHour(1013, d);
    expect(r).toMatchObject({ printed: true, status: "no_index" });
    expect(d.ping).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("ping withheld: every venue failed"))).toBe(true);
  });
  it("in collect-only mode does not ping on the no-op path (only the run that inserted the print pings)", async () => {
    const d = deps({ publish: undefined });
    const r = await runHour(1012, d);
    expect(r.printed).toBe(false);
    expect(d.ping).not.toHaveBeenCalled();
  });
  it("uses the seed fee and says so when the chain read failed and no fee was ever stored", async () => {
    await sql`truncate chain`;
    const lines: string[] = [];
    const r = await runHour(1005, deps({ readChain: async () => ({ ok: false, reason: "403" }), log: (l) => lines.push(l) }));
    expect(r.energyFeeSun).toBe(100);
    expect(lines.some((l) => l.includes("the seed"))).toBe(true);
  });
  it("a failed or throwing ping never fails the hour, and every log line is redacted", async () => {
    const lines: string[] = [];
    const d = deps({ ping: vi.fn(async () => { throw new Error("monitor down"); }), redact: (s) => s.replace(/hour/g, "H"), log: (l) => lines.push(l) });
    const r = await runHour(1006, d);
    expect(r.printed).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.includes("hour"))).toBe(true);
    expect(lines.some((l) => l.includes("ping failed"))).toBe(true);
  });
  it("falls back to the last stored fee, names its hour in the log, and collects with it", async () => {
    await insertChain(sql, { hour: 2000, energyFeeSun: 137, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() });
    const seen: number[] = [];
    const v = venue("fee");
    v.request = (_s, _t, ctx) => { seen.push(ctx.energyFeeSun); return { url: "https://fee.test/q", init: {} }; };
    const lines: string[] = [];
    const r = await runHour(2001, deps({ venues: [v], readChain: async () => ({ ok: false, reason: "403" }), log: (l) => lines.push(l) }));
    expect(r.energyFeeSun).toBe(137);
    expect(seen).toEqual([137]);
    expect(lines.some((l) => l.includes("stored for hour 2000") && l.includes("137"))).toBe(true);
  });
  it("stores the TRX price on the chain row and passes it to the venues", async () => {
    const seen: (number | null)[] = [];
    const v = venue("px");
    v.request = (_s, _t, ctx) => { seen.push(ctx.trxUsd); return { url: "https://px.test/q", init: {} }; };
    await runHour(2002, deps({ venues: [v], readTrxUsd: async () => ({ ok: true, trxUsd: 0.31 }) }));
    expect(seen).toEqual([0.31]);
    expect((await chainForHour(sql, 2002))?.trxUsd).toBe(0.31);
  });
  it("logs a CoinGecko failure and still prints", async () => {
    const lines: string[] = [];
    const r = await runHour(2003, deps({ readTrxUsd: async () => ({ ok: false, reason: "network: down" }), log: (l) => lines.push(l) }));
    expect(r).toMatchObject({ printed: true, status: "live" });
    expect(lines.some((l) => l.includes("coingecko failed: network: down"))).toBe(true);
    expect((await chainForHour(sql, 2003))?.trxUsd).toBeNull();
  });
  it("reports a publish failure instead of throwing, and does not ping", async () => {
    const lines: string[] = [];
    const d = deps({ publish: vi.fn(async () => { throw new Error("disk full"); }), log: (l) => lines.push(l) });
    const r = await runHour(2004, d);
    expect(r).toMatchObject({ printed: true, published: false });
    expect(d.ping).not.toHaveBeenCalled();
    expect(lines).toContain("hour 2004: publish failed: disk full");
    expect((await allPrints(sql)).some((p) => p.hour === 2004)).toBe(true);
  });
  it("reports published true only when publish ran and succeeded", async () => {
    expect((await runHour(2005, deps())).published).toBe(true);
    expect((await runHour(2006, deps({ publish: undefined, ping: undefined }))).published).toBe(false);
  });
  it("a chain-table write failure is logged and collection continues", async () => {
    const lines: string[] = [];
    const bad = deps({
      readChain: async (hour) => ({ ok: true, params: { hour, energyFeeSun: 100, totalEnergyWeightTrx: Number.NaN, totalEnergyLimit: 1, trxUsd: null, readAt: new Date("invalid") } }),
      log: (l) => lines.push(l),
    });
    const r = await runHour(2007, bad);
    expect(r.printed).toBe(true);
    expect(lines.some((l) => l.includes("storing the chain row failed"))).toBe(true);
  });
  it("two concurrent calls in one process collect once and return the same result", async () => {
    let fetches = 0;
    const fetchImpl = (async () => { fetches++; await new Promise((r) => setTimeout(r, 30)); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const lines: string[] = [];
    const mk = () => deps({ fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl }, log: (l) => lines.push(l) });
    const [a, b] = await Promise.all([runHour(2008, mk()), runHour(2008, mk())]);
    expect(fetches).toBe(3);
    expect(b).toBe(a);
    expect(a.printed).toBe(true);
    expect(lines.some((l) => l.includes("already running in this process"))).toBe(true);
  });
  it("prints from the stored rows when an earlier run's quotes won the conflict", async () => {
    const stored = (venueName: string, sunPerUnit: number) => ({ hour: 2009, venue: venueName, size: 20_000_000, term: "1h" as const, sunPerUnit, depth: 20_000_000, readAt: new Date(), source: "earlier", status: "ok" as const, reason: null, payloadHash: null });
    await insertQuotes(sql, [stored("a", 10), stored("b", 20)]);
    const published: number[][] = [];
    const d = deps({ publish: vi.fn(async (_h: number, _p: unknown, quotes: { sunPerUnit: number | null }[]) => { published.push(quotes.map((q) => q.sunPerUnit ?? -1)); }) });
    const r = await runHour(2009, d);
    const rows = await quotesForHour(sql, 2009);
    const row = (await allPrints(sql)).find((p) => p.hour === 2009)!;
    const again = makePrint(rows, { now: new Date(), hour: 2009 });
    expect(row.median).toBe(20);
    expect({ ...row, printedAt: 0 }).toEqual({ ...again, printedAt: 0 });
    expect(r.status).toBe("live");
    expect(published[0]).toEqual(rows.map((q) => q.sunPerUnit ?? -1));
  });
  it("a no-op run for an hour older than the newest print does not republish it", async () => {
    await runHour(4000, deps());
    await runHour(4001, deps());
    const lines: string[] = [];
    const d = deps({ log: (l) => lines.push(l) });
    const r = await runHour(4000, d);
    expect(r).toMatchObject({ hour: 4000, printed: false, published: false });
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.ping).not.toHaveBeenCalled();
    expect(lines).toContain("hour 4000: a later print exists; not republishing hour 4000");
  });
  it("never takes the fallback fee from a later hour's chain row", async () => {
    await insertChain(sql, { hour: 3000, energyFeeSun: 151, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() });
    await insertChain(sql, { hour: 3500, energyFeeSun: 999, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() });
    const seen: number[] = [];
    const v = venue("later");
    v.request = (_s, _t, ctx) => { seen.push(ctx.energyFeeSun); return { url: "https://later.test/q", init: {} }; };
    const lines: string[] = [];
    const r = await runHour(3001, deps({ venues: [v], readChain: async () => ({ ok: false, reason: "403" }), log: (l) => lines.push(l) }));
    expect(r.energyFeeSun).toBe(151);
    expect(seen).toEqual([151]);
    expect(lines.some((l) => l.includes("stored for hour 3000"))).toBe(true);
  });
  it("reads the verification wallets after the print, the publish and the ping, and logs the counts", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const now = new Date("2026-10-28T14:00:02Z");
    const readWallets = vi.fn(async (hour: number, at: Date) => {
      order.push(`wallets printed=${await hasPrint(sql, hour)} at=${at.toISOString()}`);
      return { read: 7, failed: 2 };
    });
    const d = deps({
      readWallets,
      publish: vi.fn(async () => { order.push("publish"); }),
      ping: vi.fn(async () => { order.push("ping"); return true; }),
      log: (l) => lines.push(l),
    });
    const r = await runHour(5000, d, now);
    expect(r).toMatchObject({ hour: 5000, printed: true, published: true });
    expect(readWallets).toHaveBeenCalledWith(5000, now);
    expect(order).toEqual(["publish", "ping", `wallets printed=true at=${now.toISOString()}`]);
    expect(lines).toContain("hour 5000: verification reads 7 ok, 2 failed");
  });
  it("reads the verification wallets in collect-only mode too", async () => {
    const readWallets = vi.fn(async () => ({ read: 1, failed: 0 }));
    await runHour(5001, deps({ publish: undefined, ping: undefined, readWallets }));
    expect(readWallets).toHaveBeenCalledTimes(1);
  });
  it("a failing verification read never fails the hour: logged (redacted), print and ping kept", async () => {
    const lines: string[] = [];
    const d = deps({
      readWallets: vi.fn(async () => { throw new Error("connection refused SECRETKEY"); }),
      redact: (l) => l.replace("SECRETKEY", "[redacted]"),
      log: (l) => lines.push(l),
    });
    const r = await runHour(5002, d);
    expect(r).toMatchObject({ hour: 5002, printed: true, published: true });
    expect(d.ping).toHaveBeenCalledTimes(1);
    expect(lines).toContain("hour 5002: verification reads failed: connection refused [redacted]");
  });
  it("says once each printed hour that verification reads are disabled when start-up disabled them", async () => {
    const lines: string[] = [];
    await runHour(5003, deps({ verificationDisabled: true, log: (l) => lines.push(l) }));
    await runHour(5004, deps({ verificationDisabled: true, log: (l) => lines.push(l) }));
    expect(lines.filter((l) => l.includes("verification reads disabled"))).toEqual([
      "hour 5003: verification reads disabled (see start-up log)",
      "hour 5004: verification reads disabled (see start-up log)",
    ]);
    const quiet: string[] = [];
    await runHour(5005, deps({ log: (l) => quiet.push(l) }));
    expect(quiet.some((l) => l.includes("verification"))).toBe(false);
  });
  it("does not read the verification wallets on the no-op paths (only the run that inserted the print reads)", async () => {
    const readWallets = vi.fn(async () => ({ read: 1, failed: 0 }));
    const r = await runHour(5000, deps({ readWallets }));
    expect(r.printed).toBe(false);
    expect(readWallets).not.toHaveBeenCalled();
  });
  it("stores each venue body once and every quote's payloadHash joins to it", async () => {
    const body = '{"answer":"hour 6000"}';
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const r = await runHour(6000, deps({ fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl } }));
    expect(r).toMatchObject({ printed: true, status: "live" });
    const joined = await sql<{ venue: string; body: string }[]>`select q.venue, p.body from quotes q join payloads p on p.payload_hash = q.payload_hash where q.hour = 6000 order by q.venue`;
    expect(joined.map((j) => [j.venue, j.body])).toEqual([["a", body], ["b", body], ["c", body]]);
    const hash = createHash("sha256").update(body).digest("hex");
    expect((await sql`select 1 from payloads where payload_hash = ${hash}`).length).toBe(1);
  });
  it("a failed payload insert is logged and never stops the print, the publish or the ping: payloads are evidence, not the index", async () => {
    // Postgres text cannot hold a NUL byte, so this body cannot be stored.
    const fetchImpl = (async () => new Response('{"bad":"\u0000"}', { status: 200 })) as unknown as typeof fetch;
    const lines: string[] = [];
    const d = deps({ fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl }, log: (l) => lines.push(l) });
    const r = await runHour(6001, d);
    expect(r).toMatchObject({ hour: 6001, printed: true, status: "live", published: true });
    expect(d.publish).toHaveBeenCalledTimes(1);
    expect(d.ping).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.startsWith("hour 6001: storing the raw payloads failed:"))).toBe(true);
    expect(await hasPrint(sql, 6001)).toBe(true);
  });
});

describe.skipIf(!url)("collect-only venues", () => {
  /** A venue that answers `sun` with full depth, behind a publish gate. */
  const gated = (name: string, sun: number): VenueAdapter => ({ ...venue(name), publishGate: `PUBLISH_${name.toUpperCase()}`, parse: () => ({ raw: { kind: "sunPerUnit", value: sun, term: "1h" }, depth: 20_000_000 }) });

  it("stores a gated venue's quote but leaves it out of the print and the published quotes", async () => {
    const d = deps({ venues: [venue("a"), venue("b"), gated("g", 10)], collectOnly: new Set(["g"]) });
    const r = await runHourUnguarded(7000, d, new Date("2026-10-28T14:00:03Z"));
    // Two depth-aware venues without g: no index, though g would have made three.
    expect(r).toMatchObject({ printed: true, status: "no_index", published: true });
    expect((await quotesForHour(sql, 7000)).map((q) => q.venue)).toEqual(["a", "b", "g"]);
    const [, p, published] = (d.publish as unknown as { mock: { calls: [number, { depthAwareCount: number; cheapest: number | null }, { venue: string }[]][] } }).mock.calls[0]!;
    expect(p).toMatchObject({ depthAwareCount: 2, cheapest: 40 });
    expect(published.map((q) => q.venue)).toEqual(["a", "b"]);
    expect(d.ping).toHaveBeenCalledTimes(1);
  });
  it("leaves the gated venue out of a republished stored print too", async () => {
    const d = deps({ venues: [venue("a"), venue("b"), gated("g", 10)], collectOnly: new Set(["g"]) });
    const r = await runHourUnguarded(7000, d, new Date("2026-10-28T14:30:00Z"));
    expect(r).toMatchObject({ printed: false, published: true });
    const [, , published] = (d.publish as unknown as { mock: { calls: [number, unknown, { venue: string }[]][] } }).mock.calls[0]!;
    expect(published.map((q) => q.venue)).toEqual(["a", "b"]);
  });
  it("keeps every gated venue collect-only when no set is wired", async () => {
    const d = deps({ venues: [venue("a"), venue("b"), gated("g", 10)] });
    await runHourUnguarded(7001, d, new Date("2026-10-28T15:00:03Z"));
    const [, , published] = (d.publish as unknown as { mock: { calls: [number, unknown, { venue: string }[]][] } }).mock.calls[0]!;
    expect(published.map((q) => q.venue)).toEqual(["a", "b"]);
  });
  it("counts and publishes a gated venue whose gate is open", async () => {
    const d = deps({ venues: [venue("a"), venue("b"), gated("g", 10)], collectOnly: new Set() });
    const r = await runHourUnguarded(7002, d, new Date("2026-10-28T16:00:03Z"));
    expect(r).toMatchObject({ printed: true, status: "live" });
    const [, p, published] = (d.publish as unknown as { mock: { calls: [number, { cheapest: number | null }, { venue: string }[]][] } }).mock.calls[0]!;
    expect(p.cheapest).toBe(10);
    expect(published.map((q) => q.venue)).toEqual(["a", "b", "g"]);
  });
});
