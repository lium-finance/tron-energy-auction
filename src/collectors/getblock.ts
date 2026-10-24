import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const PAGE = "https://getblock.io/tron-energy";
const NUM = "([0-9]+(?:\\.[0-9]+)?)";
/**
 * The whole 65k row of the page's pricing table, after scripts, styles and tags are stripped:
 * "65k 1.95 TRX 6.5 TRX 4.55 TRX 70%" (volume, 1h rental, burn, savings; recorded 2026-10-22 in
 * docs/verification/venue-apis.md, fixture test/fixtures/getblock-page.html). The lookbehind keeps "165k" and
 * "1.65k" from matching.
 */
const ROW_65K = new RegExp(`(?<![\\w.,])65k\\s+${NUM}\\s+TRX\\s+${NUM}\\s+TRX\\s+${NUM}\\s+TRX\\s+${NUM}\\s*%`, "gi");
/** The rental column's header; without it the prices may not be for one hour. */
const HEADER_1H = /(?<![\w.,])1h\s+Rental\b/i;
/** Rental + savings must equal burn to this many TRX, or the columns are not the ones recorded. */
const SUM_TOLERANCE_TRX = 0.01;
/** Savings / burn must equal the row's percentage to this many points; this tells savings from rental. */
const PCT_TOLERANCE = 1;

export const GETBLOCK_NOTE = "price of the 65,000-unit 1-hour tier; venue lists no larger size; 10M+ a day is contract-priced";

/** Page text: script and style blocks removed, tags replaced by spaces, non-breaking spaces decoded, whitespace collapsed. */
export function pageText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ");
}

/**
 * GetBlock has no keyless price API: its API needs an account. Its public page lists flat 1-hour tiers up to
 * 540,000 units, and sizes of 10M+ a day are "enterprise pricing". The 65k tier (the TRX for one USDT
 * transfer's energy for an hour) is the headline price; the page says nothing about depth, so every row is
 * `depth-unknown` and never enters the hourly print.
 */
export const getblock: VenueAdapter = {
  venue: "getblock",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  fetchOptions: { expect: "html" },
  request() {
    return { url: PAGE, init: { method: "GET", headers: { accept: "text/html", "user-agent": "Mozilla/5.0 tron-energy-index" } } };
  },
  parse(body): Parsed {
    const text = pageText(body);
    if (!HEADER_1H.test(text)) throw new Error('"1h Rental" header not found on the page');
    const rows = [...text.matchAll(ROW_65K)];
    if (rows.length !== 1) throw new Error(`expected one 65k row, found ${rows.length}`);
    const [rental, burn, savings, pct] = [rows[0]![1], rows[0]![2], rows[0]![3], rows[0]![4]].map(Number) as [number, number, number, number];
    if (!(rental > 0)) throw new Error(`65k rental ${rows[0]![1]} is not a positive number`);
    if (!(Math.abs(rental + savings - burn) <= SUM_TOLERANCE_TRX)) {
      throw new Error(`65k row does not add up: rental ${rental} + savings ${savings} is not burn ${burn}`);
    }
    if (!(burn > 0 && Math.abs((savings / burn) * 100 - pct) <= PCT_TOLERANCE)) {
      throw new Error(`65k row percentage ${pct}% does not match savings ${savings} of burn ${burn}`);
    }
    return { raw: { kind: "trxPerTransfer", value: rental, term: "1h" }, depth: null, note: GETBLOCK_NOTE };
  },
};
