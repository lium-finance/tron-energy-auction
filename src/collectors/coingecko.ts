import { fetchQuote, type FetchOptions } from "./http.js";
import { errorMessage } from "../core/errors.js";

const URL = "https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=usd";

/** The TRX price in USD, for USDT-quoted series. Never throws: any failure comes back as a reason the caller redacts and stores. */
export async function readTrxUsd(o: FetchOptions): Promise<{ ok: true; trxUsd: number } | { ok: false; reason: string }> {
  const r = await fetchQuote(URL, { method: "GET" }, o);
  if (!r.ok) return { ok: false, reason: `${r.kind}: ${r.reason}` };
  let v: unknown;
  try {
    v = (JSON.parse(r.body) as { tron?: { usd?: unknown } } | null)?.tron?.usd;
  } catch (e) {
    return { ok: false, reason: `schema: ${errorMessage(e)}`.slice(0, 200) };
  }
  if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, reason: "schema: tron.usd missing or not a number" };
  if (v <= 0) return { ok: false, reason: "schema: tron.usd is not positive" };
  return { ok: true, trxUsd: v };
}
