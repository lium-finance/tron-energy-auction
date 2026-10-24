import type { Quote, QuoteStatus } from "../core/types.js";

const STATUS_ORDER: readonly QuoteStatus[] = ["ok", "no-depth", "depth-unknown", "rejected", "failed", "missing"];

/** One line per quote, as the smoke script prints it. */
export function quoteLine(q: Quote): string {
  return `${q.venue.padEnd(13)} ${String(q.size).padStart(9)} ${q.term.padEnd(3)} ${q.status.padEnd(13)} ${q.sunPerUnit ?? "—"} depth=${q.depth ?? "?"}${q.reason ? ` (${q.reason})` : ""}`;
}

/** Quotes per status, in a fixed order, zero counts left out. */
export function statusCounts(quotes: readonly Quote[]): { status: QuoteStatus; count: number }[] {
  return STATUS_ORDER.map((status) => ({ status, count: quotes.filter((q) => q.status === status).length })).filter((c) => c.count > 0);
}

/** The closing line: quotes per status, and whether the chain read and the CoinGecko read worked. */
export function smokeSummary(quotes: readonly Quote[], chainOk: boolean, coingeckoOk: boolean): string {
  const counts = statusCounts(quotes);
  const text = counts.length === 0 ? "no quotes" : counts.map((c) => `${c.status}=${c.count}`).join(" ");
  return `summary: ${quotes.length} quotes (${text}); chain ${chainOk ? "ok" : "FAILED"}; coingecko ${coingeckoOk ? "ok" : "FAILED"}`;
}

/**
 * Smoke is a report, so a venue that fails does not fail it. It exits 1 only when nothing worked: the chain read
 * failed and no venue answered (every quote is failed or missing, which includes the case of no quotes at all).
 */
export function smokeExitCode(quotes: readonly Quote[], chainOk: boolean): 0 | 1 {
  const anyVenueAnswered = quotes.some((q) => q.status !== "failed" && q.status !== "missing");
  return !chainOk && !anyVenueAnswered ? 1 : 0;
}
