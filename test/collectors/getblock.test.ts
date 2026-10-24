import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { collect, type CollectContext } from "../../src/collectors/adapter.js";
import { GETBLOCK_NOTE, getblock } from "../../src/collectors/getblock.js";

const page = readFileSync(new URL("../fixtures/getblock-page.html", import.meta.url), "utf8");
const answer = (body: string, type = "text/html"): typeof fetch =>
  vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": type } })) as unknown as typeof fetch;
const ctx = (fetchImpl: typeof fetch): CollectContext => ({
  hour: 1, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
  fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl },
  redact: (s) => s, env: {},
});
const run = async (body: string) => (await collect(getblock, ctx(answer(body))))[0]!;
/** A minimal table in the recorded layout. */
const table = (row: string, header = "1h Rental"): string =>
  `<table><tr><th>Energy Volume</th><th>${header}</th><th>Burn TRX</th><th>Your Savings</th></tr>${row}</table>`;

describe("getblock", () => {
  it("reads the 65k row from the recorded page as 30 sun per unit, depth unknown, and says what was priced", async () => {
    const q = await run(page);
    expect(q).toMatchObject({
      venue: "getblock", size: 20_000_000, term: "1h", sunPerUnit: 30, depth: null, status: "depth-unknown",
      reason: "price of the 65,000-unit 1-hour tier; venue lists no larger size; 10M+ a day is contract-priced",
      source: "https://getblock.io/tron-energy",
    });
    expect(q.reason).toBe(GETBLOCK_NOTE);
    expect(q.payloadHash).toHaveLength(64);
  });
  it("accepts the HTML page only because the venue sets expect html", async () => {
    const f = answer(page);
    await collect(getblock, ctx(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(getblock.fetchOptions).toEqual({ expect: "html" });
    const [asJson] = await collect({ ...getblock, fetchOptions: undefined }, ctx(answer(page)));
    expect(asJson).toMatchObject({ status: "failed" });
    expect(asJson!.reason).toMatch(/^not-json: /);
  });
  it("fails with a schema reason when the tier table is gone", async () => {
    const q = await run("<html><body>new design</body></html>");
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q.reason).toBe('schema: "1h Rental" header not found on the page');
  });
  it("fails when the rental header says another term", async () => {
    const q = await run(page.replace("1h Rental", "24h Rental"));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q.reason).toBe('schema: "1h Rental" header not found on the page');
  });
  it("fails when the columns are reordered, because rental + savings no longer equals burn", async () => {
    // Swap the 65k row's rental (1.95) and burn (6.5) cells.
    const swapped = page
      .replace('<span class="te-rental-num" data-v-c65c96c8>1.95</span>', "@@RENTAL@@")
      .replace('<td class="te-col-burn" data-v-c65c96c8>6.5 TRX</td>', '<td class="te-col-burn" data-v-c65c96c8>1.95 TRX</td>')
      .replace("@@RENTAL@@", '<span class="te-rental-num" data-v-c65c96c8>6.5</span>');
    expect(swapped).not.toBe(page);
    const q = await run(swapped);
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q.reason).toBe("schema: 65k row does not add up: rental 6.5 + savings 4.55 is not burn 1.95");
  });
  it("fails the savings, burn, rental column order, because the percentage no longer matches savings / burn", async () => {
    // Sums still hold (4.55 + 1.95 = 6.5), so only the percentage check catches it.
    const q = await run(table("<tr><td>65k</td><td>4.55 TRX</td><td>6.5 TRX</td><td>1.95 TRX 70%</td></tr>"));
    expect(q).toMatchObject({ status: "failed", sunPerUnit: null });
    expect(q.reason).toBe("schema: 65k row percentage 70% does not match savings 1.95 of burn 6.5");
  });
  it("still reads the right row when a partial decoy '65k 9.9 TRX' comes before the table", async () => {
    const q = await run(page.replace("<section", "<p>Rent 65k 9.9 TRX today</p><section"));
    expect(q).toMatchObject({ status: "depth-unknown", sunPerUnit: 30 });
  });
  it("ignores a full decoy row inside a script or style block", async () => {
    const decoy = "65k 9.9 TRX 10 TRX 0.1 TRX 1%";
    const q = await run(`<script>var t="${decoy}";</script><style>/* ${decoy} */</style>${page}`);
    expect(q).toMatchObject({ status: "depth-unknown", sunPerUnit: 30 });
  });
  it("fails on a second full 65k row in the page text rather than guess", async () => {
    const q = await run(`<p>65k 9.9 TRX 10 TRX 0.1 TRX 1%</p>${page}`);
    expect(q).toMatchObject({ status: "failed" });
    expect(q.reason).toBe("schema: expected one 65k row, found 2");
  });
  it("does not read 1.65k, 165k or 650k as the 65k row", async () => {
    for (const vol of ["1.65k", "165k", "650k"]) {
      const q = await run(table(`<tr><td>${vol}</td><td>1.95 TRX</td><td>6.5 TRX</td><td>4.55 TRX 70%</td></tr>`));
      expect(q.reason).toBe("schema: expected one 65k row, found 0");
    }
  });
  it("decodes &nbsp; between a number and its unit", async () => {
    const q = await run(table("<tr><td>65k</td><td>1.95&nbsp;TRX</td><td>6.5&nbsp;TRX</td><td>4.55&nbsp;TRX&nbsp;70%</td></tr>"));
    expect(q).toMatchObject({ status: "depth-unknown", sunPerUnit: 30 });
  });
  it("rejects a tier price that normalises above the energy fee", async () => {
    const q = await run(table("<tr><td>65k</td><td>7.5 TRX</td><td>10 TRX</td><td>2.5 TRX 25%</td></tr>"));
    expect(q).toMatchObject({ status: "rejected", sunPerUnit: null });
    expect(q.reason).toMatch(/above the energy fee/);
  });
});
