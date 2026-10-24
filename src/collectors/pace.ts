/** TronGrid's over-limit answers: a 429 (fetchQuote's "rate-limited") or HTTP 200 with {"Error":"request rate exceeded..."}. */
export const RATE_LIMITED = /rate-limited|rate exceeded|rate limit/i;
/** A rate-limited request is retried once after this. */
export const RATE_LIMIT_RETRY_MS = 2_000;
/** Default pacing: unauthenticated TronGrid allows 3 requests a second. */
export const VERIFY_RPS_DEFAULT = 2;

/**
 * Fetch options for paced TronGrid reads (wallet reads, the top-100 builder): no hedged second request and no 429
 * backoff inside fetchQuote, so a 429 comes back as rate-limited at once and the pacer owns the single retry.
 */
export const PACED_FETCH_OPTIONS = { budgetMs: 20_000, retryAtMs: 19_999, backoffMs: Number.MAX_SAFE_INTEGER } as const;

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface PaceOptions {
  /** Requests a second; default 2. */
  rps?: number;
  retryAfterMs?: number;
  /** No request starts at or after this (epoch ms); default never. */
  stopAt?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/**
 * Sequential, paced requests with one retry on a rate limit. `run(read, onRetry)` waits for the next slot (1/rps after
 * the previous request started), calls `read`, and when the answer is a rate-limit failure waits `retryAfterMs`, says so
 * through `onRetry`, and calls it once more in the next slot. Resolves null when a slot falls at or after `stopAt`.
 */
export function pacer(o: PaceOptions = {}) {
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const intervalMs = 1000 / (o.rps ?? VERIFY_RPS_DEFAULT);
  const retryAfterMs = o.retryAfterMs ?? RATE_LIMIT_RETRY_MS;
  const stopAt = o.stopAt ?? Number.POSITIVE_INFINITY;
  let nextAt = clock();

  async function slot<R>(read: (now: Date) => Promise<R>): Promise<R | null> {
    const wait = nextAt - clock();
    if (wait > 0) await sleep(wait);
    if (clock() >= stopAt) return null;
    nextAt = clock() + intervalMs;
    return read(new Date(clock()));
  }

  return {
    clock,
    retryAfterMs,
    async run<R extends { ok: true } | { ok: false; reason: string }>(read: (now: Date) => Promise<R>, onRetry: (reason: string) => void): Promise<R | null> {
      const r = await slot(read);
      if (r && !r.ok && RATE_LIMITED.test(r.reason)) {
        onRetry(r.reason);
        await sleep(retryAfterMs);
        return slot(read);
      }
      return r;
    },
  };
}
