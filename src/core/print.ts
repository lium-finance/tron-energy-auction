import { median, to4dp } from "./stats.js";
import { INSTRUMENT, METHOD_VERSION, type Print, type Quote } from "./types.js";

export const STALE_MS = 60 * 60 * 1000;
export const MIN_LIVE = 3;

/** A venue that can fill the instrument: a quote for its size and term whose reported depth covers it, whatever its status. print() and the page both use this, so they cannot disagree. */
export function isDepthAware(q: Pick<Quote, "size" | "term" | "depth">): boolean {
  return q.size === INSTRUMENT.units && q.term === "1h" && q.depth !== null && q.depth >= INSTRUMENT.units;
}

/** A depth-aware quote that counts toward the median: status ok, a positive finite price, read less than STALE_MS before `now`. */
export function isLive(q: Pick<Quote, "size" | "term" | "depth" | "status" | "sunPerUnit" | "readAt">, now: Date): boolean {
  const age = now.getTime() - q.readAt.getTime();
  return (
    isDepthAware(q) &&
    q.status === "ok" &&
    typeof q.sunPerUnit === "number" &&
    Number.isFinite(q.sunPerUnit) &&
    q.sunPerUnit > 0 &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < STALE_MS
  );
}

/**
 * The published method. A quote is live when it is `ok`, for the hourly instrument's size and term, has
 * depth of at least the instrument, and was read less than 60 minutes before `now`. One quote per venue
 * (the latest). Fewer than three venues able to fill the instrument: no median (`no_index`). Fewer than
 * three live quotes: `thin`. The median of an even count is the mean of the two middle values.
 * Median, cheapest and dearest are rounded to four decimals, the precision the prints table stores.
 * The latest quote per venue wins whatever its status: a venue's latest answer is its current state.
 * Only quotes stamped with the caller's hour count; quotes with an invalid or future `readAt` never do.
 */
export function print(quotes: readonly Quote[], opts: { now: Date; hour: number }): Print {
  const candidates = quotes.filter(
    (q) =>
      q.hour === opts.hour &&
      q.size === INSTRUMENT.units &&
      q.term === "1h" &&
      Number.isFinite(q.readAt.getTime()),
  );
  const latestByVenue = new Map<string, Quote>();
  for (const q of candidates) {
    const prev = latestByVenue.get(q.venue);
    if (!prev || q.readAt.getTime() > prev.readAt.getTime()) latestByVenue.set(q.venue, q);
  }
  const perVenue = [...latestByVenue.values()];
  const depthAware = perVenue.filter((q) => isDepthAware(q));
  const live = depthAware.filter((q) => isLive(q, opts.now));
  const prices = live.map((q) => q.sunPerUnit as number);
  const enough = depthAware.length >= MIN_LIVE;
  return {
    hour: opts.hour,
    median: enough && prices.length > 0 ? to4dp(median(prices) as number) : null,
    cheapest: prices.length ? to4dp(Math.min(...prices)) : null,
    dearest: prices.length ? to4dp(Math.max(...prices)) : null,
    liveCount: live.length,
    depthAwareCount: depthAware.length,
    status: !enough ? "no_index" : live.length < MIN_LIVE ? "thin" : "live",
    methodVersion: METHOD_VERSION,
    printedAt: opts.now,
  };
}
