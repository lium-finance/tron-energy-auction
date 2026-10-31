import { INSTRUMENT } from "../core/types.js";
import type { Parsed, VenueAdapter } from "./adapter.js";

const EXCHANGE = "https://www.tokengoodies.com/tronresourceexchange/exchange";
const SITE = "https://www.tokengoodies.com";
/** 1 hour at 3 seconds per block. `freezeperiod` reads 3 (days) on 1h orders too, so the block count is the term. */
const HOUR_BLOCKS = 1_200;
/** `rval` 1 is energy, 0 bandwidth (GetResourceTypeVal in the trade page's main.js, read 2026-10-28). */
const ENERGY_RVAL = 1;
/** `resourceid` on an order row: 1 is energy. */
const ENERGY_RESOURCE = 1;
const PAGE = 50;

export const TOKENGOODIES_PUBLISH_GATE = "PUBLISH_TOKENGOODIES";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function finite(o: Record<string, unknown>, i: number, name: string): number {
  const v = o[name];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`orders[${i}].${name} missing or not a number`);
  return v;
}

/**
 * TokenGoodies' on-site book of open energy buy orders (recorded 2026-10-28 in docs/verification/venue-apis-2026-10-28.md;
 * fixtures test/fixtures/tokengoodies-*.json). The trade page POSTs `{"action":"utils","type":"list_details",...}`; without
 * the page's Origin and Referer the endpoint answers HTTP 200 with `success: false, errormessage: "INVALID_REQUEST"`.
 * Each order row has `amount`, `filledamount`, `priceinsun` (sun per unit for the rental) and `freezeperiodinblocks`
 * (1200 = 1 hour). The row keeps active 1h energy orders, walks their unfilled amounts cheapest first until the instrument
 * is covered, and reports that marginal price with the amount at or below it as depth. These are buyers' bids: the price
 * at which buyers ask sellers to delegate, so depth is bid size, not energy a buyer can take.
 * An empty 1h book (the recorded state on 2026-10-28) is `no-depth` with no price, not drift.
 * The request asks for the first 50 orders; when `total` says there are more, depth is a floor (said in the empty-book reason).
 *
 * Collect-only: TokenGoodies' terms (resources/disclaimers/terms.htm, read 2026-10-28) say its data may not be
 * reproduced and discourage bots, so the rows are stored and never counted or published until PUBLISH_TOKENGOODIES=on
 * (src/index/gate.ts).
 */
export const tokengoodies: VenueAdapter = {
  venue: "tokengoodies",
  requests: [{ size: INSTRUMENT.units, term: "1h" }],
  publishGate: TOKENGOODIES_PUBLISH_GATE,
  request() {
    return {
      url: EXCHANGE,
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
          origin: SITE,
          referer: `${SITE}/trade`,
          "user-agent": "Mozilla/5.0 tron-energy-index",
        },
        body: JSON.stringify({ action: "utils", type: "list_details", rval: ENERGY_RVAL, sortkey: "payoutamountinsun", limit: PAGE, offset: 0 }),
      },
    };
  },
  parse(body, size): Parsed {
    const b = JSON.parse(body) as unknown;
    if (!isObj(b)) throw new Error("body is not an object");
    if (b.success === false || typeof b.errormessage === "string") throw new Error(`venue error: ${String(b.errormessage ?? "success false")}`);
    if (!Array.isArray(b.orders)) throw new Error("orders missing or not an array");
    const total = b.total;
    if (typeof total !== "number" || !Number.isInteger(total) || total < 0) throw new Error("total missing or not a count");
    const book: { price: number; left: number }[] = [];
    for (const [i, o] of (b.orders as unknown[]).entries()) {
      if (!isObj(o)) throw new Error(`orders[${i}] is not an object`);
      if ("resourceid" in o && o.resourceid !== ENERGY_RESOURCE) throw new Error(`orders[${i}].resourceid is ${JSON.stringify(o.resourceid)}, not energy`);
      if (o.isactive === false) continue;
      if (finite(o, i, "freezeperiodinblocks") !== HOUR_BLOCKS) continue;
      const price = finite(o, i, "priceinsun");
      const amount = finite(o, i, "amount");
      const filled = "filledamount" in o ? finite(o, i, "filledamount") : 0;
      if (!(price > 0) || amount < 0 || filled < 0) throw new Error(`orders[${i}] has a non-positive price or a negative amount`);
      const left = amount - filled;
      if (left > 0) book.push({ price, left });
    }
    const more = total > (b.orders as unknown[]).length ? `; first ${(b.orders as unknown[]).length} of ${total} orders read, depth is a floor` : "";
    if (book.length === 0) return { raw: null, depth: 0, note: `open book has no 1h energy orders${more}` };
    book.sort((x, y) => x.price - y.price);
    let depth = 0;
    let marginal = book[0]!.price;
    for (const o of book) {
      if (depth >= size) break;
      depth += o.left;
      marginal = o.price;
    }
    return { raw: { kind: "sunPerUnit", value: marginal, term: "1h" }, depth };
  },
};
