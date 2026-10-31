import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { tokengoodies } from "../../src/collectors/tokengoodies.js";

const fx = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const empty = fx("tokengoodies-list-details-empty.json");
const invalid = fx("tokengoodies-invalid-request.json");
/** Order rows copied from the recorded recent trades (addresses removed): the open book was empty when recorded. */
const constructed = fx("tokengoodies-list-details-constructed.json");
const answer = (body: string): typeof fetch =>
  vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const ctx = (fetchImpl: typeof fetch): CollectContext => ({
  hour: 1, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
  fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl },
  redact: (s) => s, env: {},
});
const calls = (f: typeof fetch) => (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
/** An HTML error page served with status 200, as a CDN or maintenance page would be. */
const ERROR_PAGE = "<!DOCTYPE html><html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center></body></html>";
type Book = { total: number; orders: Record<string, unknown>[] };
const book = (f: (o: Book) => void): string => { const o = JSON.parse(constructed) as Book; f(o); return JSON.stringify(o); };

describe("tokengoodies", () => {
  it("reads the recorded empty book as no-depth with no price, with one POST carrying the page's origin", async () => {
    const f = answer(empty);
    const quotes = await collect(tokengoodies, ctx(f));
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      venue: "tokengoodies", size: 20_000_000, term: "1h", sunPerUnit: null, depth: 0, status: "no-depth",
      reason: "open book has no 1h energy orders", source: "https://www.tokengoodies.com/tronresourceexchange/exchange",
    });
    expect(quotes[0]!.payloadHash).toHaveLength(64);
    const [url, init] = calls(f)[0]!;
    expect(url).toBe("https://www.tokengoodies.com/tronresourceexchange/exchange");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ origin: "https://www.tokengoodies.com", referer: "https://www.tokengoodies.com/trade" });
    expect(JSON.parse(init.body as string)).toEqual({ action: "utils", type: "list_details", rval: 1, sortkey: "payoutamountinsun", limit: 50, offset: 0 });
  });
  it("walks the active 1h rows of a book, skipping 3- and 7-day rows: 230,000 units, dearest 54 sun", async () => {
    const [q] = await collect(tokengoodies, ctx(answer(constructed)));
    expect(q).toMatchObject({ sunPerUnit: 54, depth: 230_000, status: "no-depth" });
  });
  it("is ok at the marginal price when the 1h bids cover the instrument, counting only unfilled amounts", async () => {
    const body = book((o) => {
      o.orders[0]!.amount = 15_000_000; o.orders[0]!.filledamount = 1_000_000; // 14M left at 50
      o.orders[1]!.amount = 10_000_000; // 10M at 54
      o.orders.push({ ...o.orders[1]!, orderid: 1, priceinsun: 60, amount: 9_000_000 }); // not needed
    });
    const [q] = await collect(tokengoodies, ctx(answer(body)));
    expect(q).toMatchObject({ sunPerUnit: 54, depth: 20_000_000, status: "ok" });
  });
  it("skips inactive and fully filled orders", async () => {
    const body = book((o) => { o.orders[0]!.isactive = false; o.orders[1]!.filledamount = o.orders[1]!.amount; });
    const [q] = await collect(tokengoodies, ctx(answer(body)));
    expect(q).toMatchObject({ sunPerUnit: null, depth: 0, status: "no-depth", reason: "open book has no 1h energy orders" });
  });
  it("says depth is a floor when the book has more orders than were read", async () => {
    const [q] = await collect(tokengoodies, ctx(answer('{"total":70,"orders":[]}')));
    expect(q!.reason).toBe("open book has no 1h energy orders; first 0 of 70 orders read, depth is a floor");
  });
  it("declares the PUBLISH_TOKENGOODIES gate", () => {
    expect(tokengoodies.publishGate).toBe("PUBLISH_TOKENGOODIES");
  });
  it("fails on the recorded INVALID_REQUEST answer, which is served with 200", async () => {
    const [q] = await collect(tokengoodies, ctx(answer(invalid)));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, depth: null, reason: "schema: venue error: INVALID_REQUEST" });
  });
  it.each([
    ["orders renamed", () => '{"total":0,"rows":[]}', "schema: orders missing or not an array"],
    ["total missing", () => '{"orders":[]}', "schema: total missing or not a count"],
    ["a bandwidth row", () => book((o) => { o.orders[0]!.resourceid = 0; }), "schema: orders[0].resourceid is 0, not energy"],
    ["a string price", () => book((o) => { o.orders[0]!.priceinsun = "50"; }), "schema: orders[0].priceinsun missing or not a number"],
    ["no block count", () => book((o) => { delete o.orders[0]!.freezeperiodinblocks; }), "schema: orders[0].freezeperiodinblocks missing or not a number"],
  ])("fails with a schema reason on drift: %s", async (_n, body, reason) => {
    const [q] = await collect(tokengoodies, ctx(answer(body())));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null, reason });
  });
  it("fails on an HTML error page served with 200", async () => {
    const [q] = await collect(tokengoodies, ctx(answer(ERROR_PAGE)));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q!.reason).toMatch(/^not-json: /);
  });
});
