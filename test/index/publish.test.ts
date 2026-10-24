import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_LIVE, STALE_MS } from "../../src/core/print.js";
import { INSTRUMENT, METHOD_VERSION, type Print, type Quote } from "../../src/core/types.js";
import { renderPage } from "../../src/index/page.js";
import { buildLatest, METHOD_TEXT, publicPrint, publishFiles, writeAtomic } from "../../src/index/publish.js";

const p: Print = { hour: 498_110, median: 40, cheapest: 30, dearest: 50, liveCount: 3, depthAwareCount: 3, status: "live", methodVersion: METHOD_VERSION, printedAt: new Date("2026-10-28T14:00:20Z") };
const q = (venue: string, over: Partial<Quote> = {}): Quote => ({ hour: 498_110, venue, size: 20_000_000, term: "1h", sunPerUnit: 40, depth: 20_000_000, readAt: new Date("2026-10-28T14:00:12Z"), source: "https://v.test/q", status: "ok", reason: null, payloadHash: "h", ...over });
const noIndex: Print = { ...p, median: null, cheapest: null, dearest: null, liveCount: 1, depthAwareCount: 1, status: "no_index" };

describe("buildLatest", () => {
  it("carries the print, every quote, the 1-day series and the chain fields", () => {
    const latest = buildLatest(p, [q("a"), q("justlend", { term: "1d", depth: null, status: "depth-unknown", reason: "venue does not report depth" })], { energyFeeSun: 100, totalEnergyWeightTrx: 1, trxUsd: 0.33 });
    expect(latest).toMatchObject({ hour: 498_110, hourStartUtc: "2026-10-28T14:00:00.000Z", print: { median: 40, status: "live" }, methodVersion: METHOD_VERSION, chain: { energyFeeSun: 100 } });
    expect(latest.quotes).toHaveLength(2);
    expect(latest.series["1d"]).toEqual([{ venue: "justlend", sunPerUnitDay: 40 }]);
  });

  it("publishes reasons as stored and adds no wallet address of its own", () => {
    const reason = "price of the 1,048,000-unit 60-minute package; no depth or 20M quote available";
    const latest = buildLatest(p, [q("tronbid", { depth: null, status: "depth-unknown", reason })], { energyFeeSun: 100, totalEnergyWeightTrx: 1, trxUsd: null });
    expect(latest.quotes[0]!.reason).toBe(reason);
    const text = JSON.stringify(latest) + renderPage(latest);
    expect(text).not.toMatch(/T[1-9A-HJ-NP-Za-km-z]{33}/);
  });
});

describe("countsTowardIndex", () => {
  it("is the print rule's own live test, so a smaller package or unknown depth never counts", () => {
    const latest = buildLatest(p, [
      q("tronsave"),
      q("tronbid", { depth: null, status: "depth-unknown", reason: "package" }),
      q("stale", { readAt: new Date("2026-10-28T12:00:00Z") }),
      q("rejected", { status: "rejected", sunPerUnit: null, reason: "above the fee" }),
      q("small", { size: 5_000_000, depth: 5_000_000 }),
      q("day", { term: "1d" }),
    ], null);
    expect(latest.quotes.map((x) => [x.venue, x.countsTowardIndex])).toEqual([
      ["tronsave", true], ["tronbid", false], ["stale", false], ["rejected", false], ["small", false], ["day", false],
    ]);
  });
});

describe("countsTowardIndex on a no_index hour", () => {
  it("is false for every quote, including a live one", () => {
    const latest = buildLatest(noIndex, [q("tronsave", { sunPerUnit: 60.5 })], null);
    expect(latest.quotes[0]!.countsTowardIndex).toBe(false);
    expect(buildLatest(p, [q("tronsave")], null).quotes[0]!.countsTowardIndex).toBe(true);
  });
});

describe("publicPrint and the feed on a no_index hour", () => {
  const stray: Print = { ...noIndex, cheapest: 60.5, dearest: 60.5 };
  it("nulls every price field for no_index and thin, never for live", () => {
    expect(publicPrint(stray)).toMatchObject({ median: null, cheapest: null, dearest: null, liveCount: 1, depthAwareCount: 1, status: "no_index" });
    expect(publicPrint(p)).toEqual(p);
    const thin: Print = { ...p, status: "thin", liveCount: 2, median: 45, cheapest: 30, dearest: 60 };
    expect(publicPrint(thin)).toEqual({ ...thin, median: null, cheapest: null, dearest: null });
    // the stored print keeps its raw values
    expect(thin).toMatchObject({ median: 45, cheapest: 30, dearest: 60 });
  });
  it("is used by latest.json and history.json, and history rows carry hourStartUtc", async () => {
    const latest = buildLatest(stray, [q("tronsave", { sunPerUnit: 60.5 })], null);
    expect(latest.print).toMatchObject({ median: null, cheapest: null, dearest: null });
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    await publishFiles(dir, latest, [stray, p]);
    const hist = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
    expect(hist[0]).toMatchObject({ status: "no_index", median: null, cheapest: null, dearest: null, hourStartUtc: "2026-10-28T14:00:00.000Z" });
    expect(hist[1]).toMatchObject({ status: "live", median: 40, cheapest: 30, hourStartUtc: "2026-10-28T14:00:00.000Z" });
  });
});

describe("a thin hour publishes no price", () => {
  const thin: Print = { ...p, status: "thin", liveCount: 2, median: 45.5, cheapest: 31.25, dearest: 59.75 };
  it("latest.json, history.json and index.html carry no median, cheapest or dearest", async () => {
    const latest = buildLatest(thin, [q("tronsave", { sunPerUnit: 45.5 })], null);
    expect(latest.print).toMatchObject({ status: "thin", liveCount: 2, median: null, cheapest: null, dearest: null });
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    await publishFiles(dir, latest, [thin]);
    const hist = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
    expect(hist[0]).toMatchObject({ status: "thin", median: null, cheapest: null, dearest: null });
    const lat = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    expect(lat.print).toMatchObject({ median: null, cheapest: null, dearest: null });
    const html = readFileSync(join(dir, "index.html"), "utf8");
    for (const v of ["31.25", "59.75"]) expect(html).not.toContain(v);
    const top = html.slice(html.indexOf('class="headline'), html.indexOf("Per-venue ladder"));
    expect(top).not.toMatch(/\d+\.\d\d sun/);
    expect(top).toContain("No price this hour: thin, 2 live quotes");
    expect(top).toContain('<span class="badge">THIN</span>');
    expect(top).toContain(`at least ${MIN_LIVE} live quotes`);
  });
  it("nothing counts toward the index on a thin or no_index hour, in latest.json or on the page; a live hour still marks its live quotes", () => {
    const quotes = [q("tronsave"), q("other", { sunPerUnit: 41 })];
    for (const pr of [thin, noIndex]) {
      const latest = buildLatest(pr, quotes, null);
      expect(latest.quotes.filter((x) => x.countsTowardIndex), pr.status).toEqual([]);
      const html = renderPage(latest);
      expect(html, pr.status).not.toContain("<td>Yes</td>");
      expect(html.match(/<tr class="dim">/g), pr.status).toHaveLength(2);
    }
    const live = buildLatest(p, quotes, null);
    expect(live.quotes.map((x) => x.countsTowardIndex)).toEqual([true, true]);
    expect(renderPage(live).match(/<td>Yes<\/td>/g)).toHaveLength(2);
  });
  it("names one live quote in the singular", () => {
    expect(renderPage(buildLatest({ ...thin, liveCount: 1 }, [], null))).toContain("No price this hour: thin, 1 live quote ");
  });
});

describe("METHOD_VERSION", () => {
  it("is 2026-10-23.1: the published method changed when thin hours stopped publishing a price", () => {
    expect(METHOD_VERSION).toBe("2026-10-23.1");
  });
});

describe("METHOD_TEXT", () => {
  it("states each constant the print rule runs on", () => {
    expect(METHOD_TEXT).toContain(INSTRUMENT.units.toLocaleString("en-US"));
    expect(METHOD_TEXT).toContain(`Fewer than ${MIN_LIVE} venues`);
    expect(METHOD_TEXT).toContain(`Fewer than ${MIN_LIVE} live quotes: the print is marked thin and publishes no price.`);
    expect(METHOD_TEXT.match(/\.( |$)/g)).toHaveLength(8);
    expect(METHOD_TEXT).toContain(`less than ${STALE_MS / 60_000} minutes`);
    expect(METHOD_TEXT).toContain(`${INSTRUMENT.termHours} hour`);
    expect(METHOD_TEXT).toContain("mean of the two middle values");
    expect(METHOD_TEXT).toContain("energy fee");
    expect(renderPage(buildLatest(noIndex, [], null))).toContain(`at least ${MIN_LIVE} venues`);
  });
});

describe("writeAtomic", () => {
  it("replaces the file whole and leaves the old one on a failed write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    await writeAtomic(join(dir, "a.json"), "one");
    await writeAtomic(join(dir, "a.json"), "two");
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe("two");
    await expect(writeAtomic(join(dir, "missing", "a.json"), "x")).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("survives concurrent writes to one file: whole content, no temp left", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    const target = join(dir, "a.json");
    const bodies = Array.from({ length: 20 }, (_, i) => `body-${i}`.repeat(1000));
    await Promise.all(bodies.map((b) => writeAtomic(target, b)));
    expect(bodies).toContain(readFileSync(target, "utf8"));
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });
});

describe("publishFiles", () => {
  it("writes latest.json, history.json and index.html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    await publishFiles(dir, buildLatest(p, [q("a")], null), [p]);
    expect(readdirSync(dir).sort()).toEqual(["history.json", "index.html", "latest.json"]);
    expect(JSON.parse(readFileSync(join(dir, "history.json"), "utf8"))).toHaveLength(1);
  });
});

describe("renderPage", () => {
  it("escapes venue strings and shows the print first", () => {
    const html = renderPage(buildLatest(p, [q("<script>alert(1)</script>", { status: "failed", sunPerUnit: null, reason: "<b>x</b>" })], null));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html.indexOf("40.00 sun")).toBeLessThan(html.indexOf("Method"));
    expect(html).toContain("LIVE, 3 live quotes");
  });

  it("is self-contained, has a viewport and a scrollable semantic table", () => {
    const html = renderPage(buildLatest(p, [q("a")], null));
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).not.toMatch(/<script|<link|@import|src=|https?:\/\/[^"' ]*\.(?:js|css|woff2?)/i);
    expect(html).toContain('<th scope="col">Venue</th>');
    expect(html).toContain('class="scroll"');
  });

  it("says why there is no index and shows no number as the index", () => {
    const tronbid = "price of the 1,048,000-unit 60-minute package; no depth or 20M quote available";
    const html = renderPage(buildLatest(noIndex, [q("tronsave", { sunPerUnit: 60.5 }), q("tronbid", { sunPerUnit: 26.29, depth: null, status: "depth-unknown", reason: tronbid })], null));
    expect(html).toContain("No index this hour: 1 venue can quote 20,000,000 units");
    expect(html).toContain(tronbid);
    const top = html.slice(html.indexOf('class="headline'), html.indexOf("Per-venue ladder"));
    expect(top).not.toMatch(/\d+\.\d\d sun/);
    expect(html.indexOf("No index this hour")).toBeLessThan(html.indexOf("Per-venue ladder"));
    expect(renderPage(buildLatest({ ...noIndex, depthAwareCount: 2 }, [], null))).toContain("No index this hour: 2 venues can quote 20,000,000 units");
  });

  it("puts the reason under the venue name and orders the columns so it sits next to the price", () => {
    const html = renderPage(buildLatest(noIndex, [q("tronsave", { sunPerUnit: 60.5 }), q("tronbid", { sunPerUnit: 26.29, depth: null, status: "depth-unknown", reason: "package note" })], null));
    const heads = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads.slice(0, 7)).toEqual(["Venue", "Counts toward index", "Sun per unit", "Status", "Size asked (units)", "Depth (units)", "Read (UTC)"]);
    expect(html).toContain('<th scope="row">tronbid<small class="reason">package note</small></th><td>No</td><td>26.29</td>');
    expect(html).toContain('<tr class="dim"><th scope="row">tronsave</th><td>No</td><td>60.50</td>');
    expect(html).toContain('<tr class="dim"><th scope="row">tronbid');
    expect(html).not.toMatch(/<tr><th scope="row">(tronsave|tronbid)/);
  });

  it("marks a live quote Yes and undimmed on a live hour", () => {
    const html = renderPage(buildLatest(p, [q("tronsave", { sunPerUnit: 60.5 }), q("tronbid", { sunPerUnit: 26.29, depth: null, status: "depth-unknown", reason: "package note" })], null));
    expect(html).toContain('<tr><th scope="row">tronsave</th><td>Yes</td><td>60.50</td>');
    expect(html).toContain('<tr class="dim"><th scope="row">tronbid');
  });

  it("escapes a hostile venue name in the term series and the ladder", () => {
    const html = renderPage(buildLatest(p, [q(`a"b'<c>`, { term: "1d", depth: null, status: "depth-unknown" }), q(`a"b'<c>`)], null));
    expect(html).not.toContain("<c>");
    expect(html.match(/a&quot;b&#39;&lt;c&gt;/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("does not show a stray cheapest or dearest as an index on a no_index page", () => {
    const html = renderPage(buildLatest({ ...noIndex, cheapest: 60.5, dearest: 60.5 }, [q("tronsave", { sunPerUnit: 60.5 })], null));
    const top = html.slice(html.indexOf('class="headline'), html.indexOf("Per-venue ladder"));
    expect(top).not.toContain("60.50");
  });

  it("labels a thin print with the count and no number", () => {
    const html = renderPage(buildLatest({ ...p, status: "thin", liveCount: 2, median: 45 }, [q("a", { sunPerUnit: 41 })], null));
    expect(html).not.toContain("45.00 sun");
    expect(html).toContain("No price this hour: thin, 2 live quotes");
    expect(html).toContain(`at least ${MIN_LIVE} live quotes`);
    expect(html).not.toContain("${MIN_LIVE}");
  });

  it("shows the hour and the print time on a no_index page, the same meta line as a live page", () => {
    const meta = "20,000,000 units for 1 hour, 2026-10-28 14:00 UTC, printed 2026-10-28 14:00:20 UTC";
    const none = renderPage(buildLatest(noIndex, [q("tronsave", { sunPerUnit: 60.5 })], null));
    const live = renderPage(buildLatest(p, [q("a")], null));
    expect(none).toContain(meta);
    expect(live).toContain(meta);
    const top = none.slice(none.indexOf('class="headline'), none.indexOf("Per-venue ladder"));
    expect(top).toContain(meta);
  });

  it("shows each ladder read time with its date", () => {
    const html = renderPage(buildLatest(p, [q("a")], null));
    expect(html).toContain("<td>2026-10-28 14:00:12</td>");
  });

  it("shows the first-print notice when nothing is published yet", () => {
    expect(renderPage(null)).toContain("First print at");
  });
});
