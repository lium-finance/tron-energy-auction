import { TRON_ADDRESS } from "../core/address.js";
import { ConfigError, envValue } from "../index/config.js";
import { redactSecrets } from "../index/redact.js";
import { shown } from "./args.js";

/**
 * The Nile lock probe's pure parts: arguments, environment, the network check and the journal line. nile-probe.ts does the
 * chain calls. The probe only ever talks to Nile: the host is this constant, and no variable or flag can change it.
 */
export const NILE_FULL_HOST = "https://nile.trongrid.io";

/**
 * Nile's genesis block id (the blockID of block 0). Source: TVM's chainid opcode returns the genesis block id, and
 * tronprotocol/tips issue 527 lists it per network as Nile 0x0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc
 * (mainnet ...2b6653dc, Shasta ...94a9059e); the eth_chainId providers report for Nile, 0xcd8690dc (3448148188), is its
 * last 4 bytes. A fullnode for any other chain returns a different block 0.
 */
export const NILE_GENESIS_BLOCK_ID = "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc";

/** 1 block is the smallest lock period to try; 864,000 blocks (30 days at 3 s) the largest. */
export const MIN_LOCK_BLOCKS = 1;
export const MAX_LOCK_BLOCKS = 864_000;
export const DEFAULT_AMOUNT_TRX = 100;
export const MAX_AMOUNT_TRX = 10_000;

export type NileCommand = { step: "status" } | { step: "delegate"; lockBlocks: number } | { step: "undelegate" } | { step: "read" };

export const NILE_USAGE = "use one of: status | delegate <lockBlocks 1..864000> | undelegate | read";

/** `status`, `delegate <lockBlocks>`, `undelegate` or `read`; anything else (including any flag) is a ConfigError. */
export function parseNileArgs(argv: readonly string[]): NileCommand {
  const [step, ...rest] = argv;
  const noMore = (): void => {
    if (rest.length > 0) throw new ConfigError(`unexpected argument "${shown(rest[0]!)}" after ${step}; ${NILE_USAGE}`);
  };
  switch (step) {
    case "status":
    case "undelegate":
    case "read":
      noMore();
      return { step };
    case "delegate": {
      const [arg, ...extra] = rest;
      if (arg === undefined) throw new ConfigError(`delegate needs a lock period in blocks; ${NILE_USAGE}`);
      if (extra.length > 0) throw new ConfigError(`unexpected argument "${shown(extra[0]!)}" after delegate ${shown(arg)}; ${NILE_USAGE}`);
      const n = Number(arg);
      if (!/^\d{1,6}$/.test(arg) || n < MIN_LOCK_BLOCKS || n > MAX_LOCK_BLOCKS) throw new ConfigError(`lockBlocks must be a whole number from ${MIN_LOCK_BLOCKS} to ${MAX_LOCK_BLOCKS}; got "${shown(arg)}"`);
      return { step, lockBlocks: n };
    }
    default:
      throw new ConfigError(step === undefined ? `no step given; ${NILE_USAGE}` : `unknown step "${shown(step)}"; ${NILE_USAGE}`);
  }
}

export interface NileEnv {
  /** 64 hex characters, without 0x. */
  privateKey: string;
  receiver: string;
  /** The deployed ResourceProbe; null skips the contract reads. */
  probeAddress: string | null;
  amountTrx: number;
}

/**
 * NILE_PRIVATE_KEY (64 hex characters, an optional 0x is dropped) and NILE_RECEIVER (base58) are required;
 * NILE_PROBE_ADDRESS (base58) is optional; NILE_AMOUNT_TRX is a whole number from 1 to 10,000, default 100. Values are
 * trimmed. A ConfigError names the variable and never echoes a key.
 */
export function nileEnv(env: NodeJS.ProcessEnv = process.env): NileEnv {
  const get = (k: string): string | null => envValue(env, k) ?? null;
  const rawKey = get("NILE_PRIVATE_KEY");
  if (rawKey === null) throw new ConfigError("NILE_PRIVATE_KEY is required");
  const privateKey = rawKey.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new ConfigError("NILE_PRIVATE_KEY must be 64 hex characters");

  const address = (k: string, v: string): string => {
    if (!TRON_ADDRESS.test(v)) throw new ConfigError(`${k} must be a base58 Tron address (T followed by 33 base58 characters)`);
    return v;
  };
  const receiver = get("NILE_RECEIVER");
  if (receiver === null) throw new ConfigError("NILE_RECEIVER is required");
  const probe = get("NILE_PROBE_ADDRESS");

  const amount = get("NILE_AMOUNT_TRX");
  let amountTrx = DEFAULT_AMOUNT_TRX;
  if (amount !== null) {
    amountTrx = Number(amount);
    if (!/^\d{1,5}$/.test(amount) || amountTrx < 1 || amountTrx > MAX_AMOUNT_TRX) throw new ConfigError(`NILE_AMOUNT_TRX must be a whole number of TRX from 1 to ${MAX_AMOUNT_TRX}; got "${shown(amount)}"`);
  }
  return { privateKey, receiver: address("NILE_RECEIVER", receiver), probeAddress: probe === null ? null : address("NILE_PROBE_ADDRESS", probe), amountTrx };
}

/** Refuses (a ConfigError, exit 2) unless the node's block 0 is Nile's genesis block. */
export function assertNileGenesis(blockId: unknown): void {
  if (blockId !== NILE_GENESIS_BLOCK_ID) {
    const got = typeof blockId === "string" && blockId !== "" ? shown(blockId) : "no block id";
    throw new ConfigError(`refusing: ${NILE_FULL_HOST} did not identify as Nile (block 0 is ${got}, expected ${NILE_GENESIS_BLOCK_ID})`);
  }
}

const MAX_ERROR_LENGTH = 500;

/**
 * A chain or library error as text, never the object: tronweb throws strings, Errors, or plain objects (which can hold the
 * request). A string is kept, an Error is its name and message, an object only its string `code` and `message`.
 */
export function chainErrorText(e: unknown): string {
  let text: string;
  if (typeof e === "string") text = e;
  else if (e instanceof Error) text = `${e.name}: ${e.message}`;
  else if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    const parts = [o.code, o.message].filter((p): p is string => typeof p === "string" && p !== "");
    text = parts.length > 0 ? parts.join(": ") : "unprintable error";
  } else text = "unprintable error";
  return text.slice(0, MAX_ERROR_LENGTH);
}

/** A broadcast's `message` is hex-encoded text; decode it when it is printable, else keep it. Null when there is none. */
export function decodeChainMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  if (message === "" || !/^(?:[0-9a-fA-F]{2})+$/.test(message)) return message;
  const text = Buffer.from(message, "hex").toString("utf8");
  return /^[\x20-\x7E\t\r\n]*$/.test(text) ? text : message;
}

/** One journal line, `{at, step, args, data}` as JSON on one line, redacted (NILE_PRIVATE_KEY is a secret-named variable). */
export function journalLine(at: Date, step: string, args: unknown, data: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return redactSecrets(JSON.stringify({ at: at.toISOString(), step, args, data }), env);
}

/**
 * The key in every form it is used, under secret-matching names (the `_KEY_` rule), to add to the environment before any
 * network call so redactSecrets and runScript's errorLine remove it however it was written: as TronWeb received it (the
 * variable with 0x/0X dropped), all lower case and all upper case.
 */
export function keyRedactionEnv(privateKey: string): Record<"NILE_PRIVATE_KEY_AS_USED" | "NILE_PRIVATE_KEY_LOWER" | "NILE_PRIVATE_KEY_UPPER", string> {
  return { NILE_PRIVATE_KEY_AS_USED: privateKey, NILE_PRIVATE_KEY_LOWER: privateKey.toLowerCase(), NILE_PRIVATE_KEY_UPPER: privateKey.toUpperCase() };
}

/** TronWeb's message when the key is not a usable secp256k1 key (zero, or not below the curve order). */
const TRONWEB_INVALID_KEY = "Invalid private key provided";

/** Runs the TronWeb constructor (which checks the key and makes no network call), turning an invalid key into a ConfigError (exit 2). */
export function constructTron<T>(create: () => T): T {
  try {
    return create();
  } catch (e) {
    if (e instanceof Error && e.message === TRONWEB_INVALID_KEY) throw new ConfigError("NILE_PRIVATE_KEY is not a valid private key");
    throw e;
  }
}
