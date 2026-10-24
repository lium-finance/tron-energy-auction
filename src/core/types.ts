/** Sun per TRX. */
export const SUN_PER_TRX = 1_000_000;

/** The reference instrument: 20,000,000 energy units for one hour, quoted in sun per unit. */
export const INSTRUMENT = { units: 20_000_000, termHours: 1 } as const;

/** The three ladder sizes a size-aware venue is asked for, in units. */
export const LADDER_UNITS = [5_000_000, 20_000_000, 50_000_000] as const;

/** Energy per USDT transfer to a holder, used to normalise per-transfer quotes. */
export const TRANSFER_UNITS = 65_000;

/** Terms the index tracks. The hourly print uses only `1h`; the others are their own series. */
export type Term = "1h" | "1d" | "7d" | "14d";

export const TERM_HOURS: Record<Term, number> = { "1h": 1, "1d": 24, "7d": 168, "14d": 336 };

export type QuoteStatus = "ok" | "missing" | "no-depth" | "failed" | "rejected" | "depth-unknown";

/** One venue's answer for one size and term in one hour. Every collector returns exactly one of these. */
export interface Quote {
  /** Unix hour (seconds / 3600), stamped by the job, not derived from readAt. */
  hour: number;
  venue: string;
  /** Units asked for. */
  size: number;
  term: Term;
  /** Sun per unit (1h), or sun per unit per day (1d, 7d, 14d). Null unless status is ok, no-depth or depth-unknown. */
  sunPerUnit: number | null;
  /** Units the venue said it could fill at that price (clamped to the size asked for; the raw value is in the stored payload). Null when the venue does not say. */
  depth: number | null;
  readAt: Date;
  /** The URL or method the quote came from. */
  source: string;
  status: QuoteStatus;
  /** Why the status is not ok, already redacted. Null when ok. */
  reason: string | null;
  /** sha256 of the raw body, so a row can be matched to a stored payload. */
  payloadHash: string | null;
}

export type PrintStatus = "live" | "thin" | "no_index";

export interface Print {
  hour: number;
  /** Sun per unit; null for no_index, and for thin when no quote is live. */
  median: number | null;
  cheapest: number | null;
  dearest: number | null;
  liveCount: number;
  /** Venues whose latest quote this hour reported depth of at least INSTRUMENT.units, whatever its status (a venue that can fill the instrument). */
  depthAwareCount: number;
  status: PrintStatus;
  methodVersion: string;
  printedAt: Date;
}

export const METHOD_VERSION = "2026-10-23.1";

export interface ChainParams {
  hour: number;
  /** Sun burned per energy unit (getEnergyFee). */
  energyFeeSun: number;
  /** TRX staked for energy network-wide, in whole TRX (TotalEnergyWeight). */
  totalEnergyWeightTrx: number;
  /** Energy units the network issues per day (getTotalEnergyLimit). */
  totalEnergyLimit: number;
  /** CoinGecko's TRX price in USD read this hour; null when that read failed. */
  trxUsd: number | null;
  readAt: Date;
}

/** One wallet's energy allowance and use at one hour; a superset of the pass module's WalletRead. */
export interface ResourceRead {
  hour: number;
  wallet: string;
  energyLimit: number;
  energyUsed: number;
  readAt: Date;
  source: string;
}
