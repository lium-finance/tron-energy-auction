import { readAccountResource, type ChainContext, type ResourceResult } from "../collectors/chain.js";
import { hourStart } from "../core/hour.js";
import type { ResourceRead } from "../core/types.js";
import { pacer } from "../collectors/pace.js";
import { tronAddressHex } from "../core/address.js";
import { insertVerification, type Sql } from "./db.js";
import type { Wallets } from "./wallet-list.js";

/** Reads stop starting this long after the first one, so the hour job stays well inside its 15-minute tick deadline. */
export const READ_BUDGET_MS = 10 * 60_000;
/**
 * No read starts later than this into its hour. The decay model in core/pass.ts takes the hour labels as the time
 * between reads, so a read stamped hour H but taken at H:50 would skew both deltas around it; an unread hour is
 * handled exactly instead (it counts towards the two unread hours a full day allows).
 */
export const LATEST_START_MS = 20 * 60_000;

export interface ReadWalletsOptions {
  /** Requests a second, sequential; default 2. */
  rps?: number;
  retryAfterMs?: number;
  /** Reads not started by then are skipped and counted as failed. Default: the earlier of start + READ_BUDGET_MS and the hour's start + LATEST_START_MS. */
  stopAt?: number;
  read?: (wallet: string, ctx: ChainContext) => Promise<ResourceResult>;
  insert?: (sql: Sql, r: ResourceRead) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/**
 * Replaces every form of `wallet` in `text` with `label`: the base58 address, and its hex form (41 then 40 hex
 * characters, or the 40 alone, in any case, with or without 0x), which TronGrid uses in some answers.
 */
export function scrubWallet(text: string, wallet: string, label: string): string {
  let out = text.split(wallet).join(label);
  const hex = tronAddressHex(wallet);
  if (hex !== null) out = out.replace(new RegExp(`(?:0x)?(?:41)?${hex.slice(2)}`, "gi"), label);
  return out;
}

/** The wallets to read, each once (a wallet in both lists is read once), with the label its log lines use: supplier[i] or top100[j], never the address. */
function readList(w: Wallets): { wallet: string; label: string }[] {
  const out: { wallet: string; label: string }[] = [];
  const seen = new Set<string>();
  w.supplier.forEach((wallet, i) => {
    if (!seen.has(wallet)) out.push({ wallet, label: `supplier[${i}]` });
    seen.add(wallet);
  });
  w.top100.wallets.forEach((wallet, j) => {
    if (!seen.has(wallet)) out.push({ wallet, label: `top100[${j}]` });
    seen.add(wallet);
  });
  return out;
}

/**
 * One hourly read of every listed wallet into `verification`, stamped with `ctx.hour` and the moment of each read.
 * Sequential and paced to `rps`; a rate-limited answer is retried once after 2 s (pass PACED_FETCH_OPTIONS in `ctx` so
 * fetchQuote does not hedge or back off on its own). A failed read is logged under the wallet's list label, with the
 * address replaced by that label in the upstream reason, and skipped, so that hour stays missing for that wallet; a failed
 * insert rejects (the database is the problem, not the wallet). Reads past `stopAt` are skipped, logged and counted as failed.
 */
export async function readWallets(sql: Sql, wallets: Wallets, ctx: ChainContext, log: (l: string) => void, o: ReadWalletsOptions = {}): Promise<{ read: number; failed: number }> {
  const clock = o.clock ?? Date.now;
  const readFn = o.read ?? readAccountResource;
  const insert = o.insert ?? insertVerification;
  const stopAt = o.stopAt ?? Math.min(clock() + READ_BUDGET_MS, hourStart(ctx.hour).getTime() + LATEST_START_MS);
  const pace = pacer({ rps: o.rps, retryAfterMs: o.retryAfterMs, stopAt, sleep: o.sleep, clock });

  const all = readList(wallets);
  let read = 0;
  let failed = 0;
  for (let i = 0; i < all.length; i++) {
    const { wallet, label } = all[i]!;
    const r = await pace.run(
      (now) => readFn(wallet, { ...ctx, now }),
      () => log(`verification ${label}: rate limited; retrying once in ${Math.round(pace.retryAfterMs / 1000)} s`),
    );
    if (r === null) {
      const left = all.length - i;
      failed += left;
      log(`verification: ${left} of ${all.length} wallets not read: past ${new Date(stopAt).toISOString()}`);
      break;
    }
    if (!r.ok) {
      failed += 1;
      log(`verification ${label}: ${scrubWallet(r.reason, wallet, label)}`);
      continue;
    }
    await insert(sql, r.read);
    read += 1;
  }
  return { read, failed };
}
