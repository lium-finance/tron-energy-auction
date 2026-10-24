import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hourOf } from "../../src/core/hour.js";
import { METHOD_VERSION, type Print, type Quote } from "../../src/core/types.js";
import { degradedCheck, pingHealthcheck, postAlert, thinShareCheck } from "../../src/index/alert.js";
import { createDb, insertChain, insertPrint, insertQuotes, type Sql } from "../../src/index/db.js";
import { runMigrations } from "../../src/index/migrate.js";
import { testDbUrl as url } from "./testdb.js";

let sql: Sql;
beforeAll(async () => { if (!url) return; await runMigrations(url); sql = createDb(url); await sql`truncate prints, alerts, quotes, chain`; });
afterAll(async () => { await sql?.end(); });

const ok: typeof fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const down: typeof fetch = (async () => { throw new Error("ECONNREFUSED https://hc-ping.com/secret-uuid"); }) as unknown as typeof fetch;
const notFound: typeof fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

describe("pingHealthcheck", () => {
  it("sends one GET and reports delivery; a failure is logged with the URL redacted and never throws", async () => {
    const f = vi.fn(ok);
    expect(await pingHealthcheck("https://hc-ping.com/abc", f, () => {})).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const lines: string[] = [];
    expect(await pingHealthcheck("https://hc-ping.com/abc", down, (l) => lines.push(l))).toBe(false);
    expect(lines[0]).toContain("https://hc-ping.com/[redacted]");
    expect(lines[0]).not.toContain("secret-uuid");
  });
  it("logs only the status code for a non-2xx answer, never the URL", async () => {
    const lines: string[] = [];
    expect(await pingHealthcheck("https://hc-ping.com/secret-uuid", notFound, (l) => lines.push(l))).toBe(false);
    expect(lines).toEqual(["[ping] monitor returned 404"]);
  });
  it("never throws even when the logger does", async () => {
    expect(await pingHealthcheck("https://hc-ping.com/abc", down, () => { throw new Error("log broke"); })).toBe(false);
  });
});

describe("postAlert", () => {
  const silent = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const env = { ALERT_WEBHOOK_URL: "https://hooks.test/x", TRONGRID_API_KEY: "abcdefghijklmnop" };
  it("posts the redacted text to the webhook and prints it; no webhook means printed only", async () => {
    const spy = silent();
    try {
      const f = vi.fn(ok);
      expect(await postAlert("https://hooks.test/x", "key abcdefghijklmnop leaked", f, env)).toBe(true);
      const init = f.mock.calls[0]![1] as RequestInit;
      expect(JSON.parse(String(init.body)).text).toBe("key [redacted] leaked");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(spy).toHaveBeenCalledWith("[alert] key [redacted] leaked\n");
      expect(await postAlert(null, "x", f, {})).toBe(false);
      expect(f).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it("reports a non-2xx answer as not delivered", async () => {
    const spy = silent();
    try {
      expect(await postAlert("https://hooks.test/x", "x", notFound, env)).toBe(false);
      expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.includes("webhook returned 404"))).toBe(true);
    } finally { spy.mockRestore(); }
  });
  it("reports a throw as not delivered, with the error redacted", async () => {
    const spy = silent();
    try {
      const boom: typeof fetch = (async () => { throw new Error("connect failed key abcdefghijklmnop at https://hooks.test/x"); }) as unknown as typeof fetch;
      expect(await postAlert("https://hooks.test/x", "x", boom, env)).toBe(false);
      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("webhook post failed");
      expect(out).not.toContain("abcdefghijklmnop");
      expect(out).not.toContain("hooks.test/x");
    } finally { spy.mockRestore(); }
  });
});

const NOW = new Date("2026-10-28T14:05:00Z");
const CUR = hourOf(NOW);
const p = (hour: number, status: Print["status"], depthAwareCount = 3): Print => ({ hour, median: status === "live" ? 40 : null, cheapest: null, dearest: null, liveCount: status === "live" ? 3 : 1, depthAwareCount, status, methodVersion: METHOD_VERSION, printedAt: new Date() });
const q = (hour: number, venue: string, status: Quote["status"], term: Quote["term"] = "1h"): Quote => ({ hour, venue, size: 20_000_000, term, sunPerUnit: status === "ok" ? 40 : null, depth: null, readAt: new Date(), source: "t", status, reason: null, payloadHash: null });
const chainRow = (hour: number) => insertChain(sql, { hour, energyFeeSun: 100, totalEnergyWeightTrx: 1, totalEnergyLimit: 1, trxUsd: null, readAt: new Date() });
const reset = () => sql`truncate prints, alerts, quotes, chain`;
/** Prints for the 24 hours ending at CUR; `statusOf(i)` for i = 0 (oldest) to 23. */
async function fillDay(statusOf: (i: number) => Print["status"]): Promise<void> {
  for (let i = 0; i < 24; i++) await insertPrint(sql, p(CUR - 23 + i, statusOf(i)));
}

describe.skipIf(!url)("thinShareCheck", () => {
  it("sends once per UTC day when more than 10 % of the last 24 prints are thin", async () => {
    await reset();
    await fillDay((i) => (i < 3 ? "thin" : "live"));
    const send = vi.fn(async (_text: string) => true);
    expect(await thinShareCheck(sql, send, NOW)).toEqual({ share: 0.125, sent: true });
    expect(await thinShareCheck(sql, send, new Date("2026-10-28T15:05:00Z"))).toEqual({ share: 0.125, sent: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toContain("thin");
    // the next UTC day, with the same prints still inside the window (now is 00:05 and the newest print is 14:00 the day before)
    const nextDay = new Date("2026-10-29T00:05:00Z");
    await reset();
    for (let i = 0; i < 24; i++) await insertPrint(sql, p(hourOf(nextDay) - 23 + i, i < 3 ? "thin" : "live"));
    await sql`insert into alerts (kind, utc_day) values ('thin-share', '2026-10-28')`;
    expect(await thinShareCheck(sql, send, nextDay)).toEqual({ share: 0.125, sent: true });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("does nothing at or under 10 %", async () => {
    await reset();
    await fillDay((i) => (i < 2 ? "thin" : "live"));
    const send = vi.fn(async () => true);
    expect(await thinShareCheck(sql, send, NOW)).toMatchObject({ sent: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("does not count no_index: 24 no_index prints send nothing, and a 3 thin + 10 no_index mix counts only thin", async () => {
    await reset();
    await fillDay(() => "no_index");
    const send = vi.fn(async (_text: string) => true);
    expect(await thinShareCheck(sql, send, NOW)).toEqual({ share: 0, sent: false });
    await reset();
    await fillDay((i) => (i < 3 ? "thin" : i < 13 ? "no_index" : "live"));
    expect(await thinShareCheck(sql, send, NOW)).toEqual({ share: 0.125, sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toContain("3 of the last 24");
  });
  it("needs a full day of prints: fewer than 24 never alerts", async () => {
    await reset();
    for (let i = 0; i < 6; i++) await insertPrint(sql, p(CUR - 5 + i, "thin"));
    const send = vi.fn(async () => true);
    expect(await thinShareCheck(sql, send, NOW)).toEqual({ share: 1, sent: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("ignores prints older than 24 hours", async () => {
    await reset();
    for (let i = 0; i < 24; i++) await insertPrint(sql, p(CUR - 100 + i, "thin"));
    const send = vi.fn(async () => true);
    expect(await thinShareCheck(sql, send, NOW)).toEqual({ share: 0, sent: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("releases the day's claim when the webhook is down so the next tick retries", async () => {
    await reset();
    await fillDay((i) => (i < 5 ? "thin" : "live"));
    const failing = vi.fn(async () => false);
    expect(await thinShareCheck(sql, failing, NOW)).toMatchObject({ sent: false });
    expect(await sql`select 1 from alerts`).toHaveLength(0);
    const working = vi.fn(async () => true);
    expect(await thinShareCheck(sql, working, new Date("2026-10-28T14:10:00Z"))).toMatchObject({ sent: true });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(working).toHaveBeenCalledTimes(1);
  });
  it("releases the claim and rethrows when send throws", async () => {
    await reset();
    await fillDay((i) => (i < 5 ? "thin" : "live"));
    await expect(thinShareCheck(sql, async () => { throw new Error("boom"); }, NOW)).rejects.toThrow("boom");
    expect(await sql`select 1 from alerts`).toHaveLength(0);
  });
  it("two concurrent checks send once", async () => {
    await reset();
    await fillDay((i) => (i < 5 ? "thin" : "live"));
    const send = vi.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return true; });
    const results = await Promise.all([thinShareCheck(sql, send, NOW), thinShareCheck(sql, send, NOW)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
  });
});

describe.skipIf(!url)("degradedCheck", () => {
  /** Two healthy hours: depth, a usable quote, a chain row. Each test then breaks one thing. */
  async function healthy(): Promise<void> {
    await reset();
    for (const h of [CUR - 1, CUR]) {
      await insertPrint(sql, p(h, "no_index", 3));
      await insertQuotes(sql, [q(h, "a", "ok"), q(h, "b", "failed")]);
      await chainRow(h);
    }
  }
  it("says nothing when the last two hours are healthy", async () => {
    await healthy();
    const send = vi.fn(async () => true);
    expect(await degradedCheck(sql, send, NOW)).toEqual({ degraded: [], sent: false });
    expect(send).not.toHaveBeenCalled();
  });
  it("alerts when no venue could fill the instrument in both hours (depthAwareCount 0)", async () => {
    await healthy();
    await sql`update prints set depth_aware_count = 0`;
    const send = vi.fn(async (_text: string) => true);
    const r = await degradedCheck(sql, send, NOW);
    expect(r.sent).toBe(true);
    expect(r.degraded).toHaveLength(1);
    expect(r.degraded[0]).toBe("no venue could fill the instrument (TronSave down, or its depth below 20,000,000 units)");
    expect(String(send.mock.calls[0]![0])).toContain(String(CUR));
  });
  it("does not alert when only one of the two hours has depthAwareCount 0", async () => {
    await healthy();
    await sql`update prints set depth_aware_count = 0 where hour = ${CUR}`;
    expect(await degradedCheck(sql, vi.fn(async () => true), NOW)).toEqual({ degraded: [], sent: false });
  });
  it("alerts when every 1h quote failed or is missing in both hours, including no quotes at all", async () => {
    await healthy();
    await sql`update quotes set status = 'failed' where status = 'ok'`;
    const send = vi.fn(async () => true);
    expect((await degradedCheck(sql, send, NOW)).degraded).toEqual(["every 1h quote failed or is missing"]);
    await healthy();
    await sql`delete from quotes`;
    expect((await degradedCheck(sql, send, new Date("2026-10-29T14:05:00Z"))).degraded).toEqual([]); // two days on: the prints are stale
    expect((await degradedCheck(sql, send, new Date("2026-10-28T14:35:00Z"))).degraded).toEqual(["every 1h quote failed or is missing"]);
  });
  it("ignores failed-looking 1d quotes and counts a 1h quote that is not failed or missing as usable", async () => {
    await healthy();
    await sql`delete from quotes`;
    await insertQuotes(sql, [q(CUR, "a", "no-depth"), q(CUR - 1, "a", "failed"), q(CUR, "j", "ok", "1d")]);
    expect(await degradedCheck(sql, vi.fn(async () => true), NOW)).toEqual({ degraded: [], sent: false });
  });
  it("alerts when there is no chain row for either hour", async () => {
    await healthy();
    await sql`truncate chain`;
    const r = await degradedCheck(sql, vi.fn(async () => true), NOW);
    expect(r.degraded).toEqual(["no chain read (energy fee and weight unknown)"]);
    expect(r.sent).toBe(true);
  });
  it("names every condition that holds", async () => {
    await healthy();
    await sql`update prints set depth_aware_count = 0`;
    await sql`truncate chain, quotes`;
    expect((await degradedCheck(sql, vi.fn(async () => true), NOW)).degraded).toHaveLength(3);
  });
  it("does not alert on one chain row present, on non-consecutive hours, on a stale feed, or with fewer than two prints", async () => {
    await healthy();
    await sql`delete from chain where hour = ${CUR - 1}`;
    expect((await degradedCheck(sql, vi.fn(async () => true), NOW)).degraded).toEqual([]);
    await healthy();
    await sql`update prints set depth_aware_count = 0`;
    await sql`update prints set hour = hour - 1 where hour = ${CUR - 1}`;
    expect((await degradedCheck(sql, vi.fn(async () => true), NOW)).degraded).toEqual([]);
    await healthy();
    await sql`update prints set depth_aware_count = 0`;
    expect((await degradedCheck(sql, vi.fn(async () => true), new Date(NOW.getTime() + 3 * 3_600_000))).degraded).toEqual([]);
    await reset();
    await insertPrint(sql, p(CUR, "no_index", 0));
    expect((await degradedCheck(sql, vi.fn(async () => true), NOW)).degraded).toEqual([]);
  });
  it("sends once per UTC day, then again the next day", async () => {
    await healthy();
    await sql`truncate chain`;
    const send = vi.fn(async () => true);
    expect((await degradedCheck(sql, send, NOW)).sent).toBe(true);
    expect((await degradedCheck(sql, send, new Date("2026-10-28T14:35:00Z"))).sent).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const nextDay = new Date("2026-10-29T00:05:00Z");
    await reset();
    for (const h of [hourOf(nextDay) - 1, hourOf(nextDay)]) await insertPrint(sql, p(h, "no_index", 3));
    await sql`insert into alerts (kind, utc_day) values ('degraded', '2026-10-28')`;
    expect((await degradedCheck(sql, send, nextDay)).sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("releases the claim when the send fails or throws", async () => {
    await healthy();
    await sql`truncate chain`;
    expect((await degradedCheck(sql, async () => false, NOW)).sent).toBe(false);
    expect(await sql`select 1 from alerts`).toHaveLength(0);
    await expect(degradedCheck(sql, async () => { throw new Error("boom"); }, NOW)).rejects.toThrow("boom");
    expect(await sql`select 1 from alerts`).toHaveLength(0);
    expect((await degradedCheck(sql, async () => true, NOW)).sent).toBe(true);
  });
  it("is independent of the thin-share claim for the same day", async () => {
    await healthy();
    await sql`truncate chain`;
    await sql`insert into alerts (kind, utc_day) values ('thin-share', '2026-10-28')`;
    expect((await degradedCheck(sql, async () => true, NOW)).sent).toBe(true);
  });
});
