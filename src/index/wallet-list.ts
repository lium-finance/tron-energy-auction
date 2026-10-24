import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TRON_ADDRESS } from "../core/address.js";
import { errorMessage } from "../core/errors.js";
import { ConfigError } from "./config.js";

/**
 * The wallets the verification facts read (docs/verification/wallets.example.json shows the shape). The real file,
 * docs/verification/wallets.json, is gitignored: its supplier list identifies the supplier.
 */
export interface Wallets {
  supplier: string[];
  top100: {
    source: string;
    readAt: string;
    shareOfTotalEnergyWeight: number;
    wallets: string[];
    /**
     * Totals of the per-wallet stake numbers, in TRX, when every entry carries both (build-top100 writes them); otherwise
     * null. delegatedOutTrx is the part of the stake delegated to other accounts, whose energy the recipients use.
     */
    stakeTotals: { energyStakeTrx: number; delegatedOutTrx: number } | null;
  };
}

/** An ISO 8601 UTC or offset timestamp, e.g. 2026-10-28T09:00:00Z. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TOP100_MAX = 150;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks every entry is a Tron address and none repeats within this list. (A wallet may be in both lists: a big staker can be the supplier.) */
function addresses(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) throw new ConfigError(`${name} must be an array of Tron addresses`);
  const seen = new Map<string, number>();
  return v.map((a: unknown, i) => {
    if (typeof a !== "string" || !TRON_ADDRESS.test(a)) throw new ConfigError(`${name}[${i}] is not a Tron address`);
    const first = seen.get(a);
    if (first !== undefined) throw new ConfigError(`${name}[${i}] repeats ${name}[${first}]`);
    seen.set(a, i);
    return a;
  });
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${what} is not valid JSON`);
  }
}

/** An optional stake number: absent, or finite and at least 0. */
function optStake(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ConfigError(`${name} must be a number of at least 0`);
  return v;
}

/**
 * top100.wallets entries: a plain address, or { address, energyStakeTrx?, delegatedOutTrx? } (build-top100's output).
 * The address gets the same checks either way. Totals are kept only when every entry has both numbers.
 */
function top100Wallets(v: unknown): { wallets: string[]; stakeTotals: Wallets["top100"]["stakeTotals"] } {
  if (!Array.isArray(v)) throw new ConfigError("top100.wallets must be an array of Tron addresses");
  let energy = 0;
  let delegated = 0;
  let allNumbers = true;
  const plain = v.map((e: unknown, i) => {
    if (!isObject(e)) {
      allNumbers = false;
      return e;
    }
    const s = optStake(e.energyStakeTrx, `top100.wallets[${i}].energyStakeTrx`);
    const d = optStake(e.delegatedOutTrx, `top100.wallets[${i}].delegatedOutTrx`);
    if (s === undefined || d === undefined) allNumbers = false;
    else {
      energy += s;
      delegated += d;
    }
    return e.address;
  });
  const wallets = addresses(plain, "top100.wallets");
  return { wallets, stakeTotals: allNumbers && wallets.length > 0 ? { energyStakeTrx: energy, delegatedOutTrx: delegated } : null };
}

/** The top100 section's rules (inline or in a top100File); extra fields such as the builder's `k` and `exact` are dropped. */
function parseTop100(t: unknown): Wallets["top100"] {
  if (!isObject(t)) throw new ConfigError("top100 must be an object");
  const { wallets, stakeTotals } = top100Wallets(t.wallets);
  if (wallets.length === 0 || wallets.length > TOP100_MAX) throw new ConfigError(`top100.wallets must list 1 to ${TOP100_MAX} wallets`);
  if (typeof t.source !== "string" || t.source.trim() === "") throw new ConfigError("top100.source must name where the list came from");
  if (typeof t.readAt !== "string" || !ISO_DATE.test(t.readAt) || !Number.isFinite(Date.parse(t.readAt))) throw new ConfigError("top100.readAt must be an ISO timestamp");
  const share = t.shareOfTotalEnergyWeight;
  if (typeof share !== "number" || !Number.isFinite(share) || share < 0 || share > 1) throw new ConfigError("top100.shareOfTotalEnergyWeight must be a number from 0 to 1");
  return { source: t.source, readAt: t.readAt, shareOfTotalEnergyWeight: share, wallets, stakeTotals };
}

/**
 * Parses and checks a wallet list: every address matches the Tron base58 shape, no address appears twice within a list
 * (one may be in both lists), supplier has at least one wallet, top100 has 1 to 150, readAt is an ISO timestamp and
 * shareOfTotalEnergyWeight is in [0, 1]. Throws a ConfigError naming the first problem; never echoes the file.
 *
 * Instead of an inline `top100`, the file may name `"top100File": "<path>"`: a committed file holding the top100 section
 * (build-top100's output; public addresses only). `readTop100File` reads it (loadWallets resolves the path against the
 * wallets file's directory); the same rules apply to it, and its errors say they came from it.
 */
export function parseWallets(text: string, readTop100File?: (path: string) => string): Wallets {
  const raw = parseJson(text, "the wallets file");
  if (!isObject(raw)) throw new ConfigError("the wallets file must be a JSON object");
  const supplier = addresses(raw.supplier, "supplier");
  if (supplier.length === 0) throw new ConfigError("supplier must list at least one wallet");
  if (raw.top100File === undefined) return { supplier, top100: parseTop100(raw.top100) };

  if (raw.top100 !== undefined) throw new ConfigError("give either top100 or top100File, not both");
  const file = raw.top100File;
  if (typeof file !== "string" || file.trim() === "") throw new ConfigError("top100File must be a path");
  if (!readTop100File) throw new ConfigError("top100File can only be read through loadWallets");
  let fileText: string;
  try {
    fileText = readTop100File(file);
  } catch (e) {
    throw new ConfigError(`top100File cannot be read: ${errorMessage(e)}`);
  }
  try {
    return { supplier, top100: parseTop100(parseJson(fileText, "top100File")) };
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`${e.message} (in top100File ${file})`);
    throw e;
  }
}

/** Reads and parses the file (and its top100File, relative to it); a read failure is a ConfigError too (exit code 2 in the scripts, a refused start in the job). */
export function loadWallets(path: string): Wallets {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`the wallets file cannot be read: ${errorMessage(e)}`);
  }
  return parseWallets(text, (file) => readFileSync(resolve(dirname(path), file), "utf8"));
}
