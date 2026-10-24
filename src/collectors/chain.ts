import { TRON_ADDRESS } from "../core/address.js";
import type { ChainParams, ResourceRead } from "../core/types.js";
import { fetchQuote, type FetchOptions } from "./http.js";
import { errorMessage } from "../core/errors.js";

const BASE = "https://api.trongrid.io";
/** A long-lived public contract address; any activated address returns the network-wide weights. */
const WEIGHT_PROBE_ADDRESS = "TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd";

export interface ChainContext {
  hour: number;
  now: Date;
  apiKey: string;
  fetchOptions: FetchOptions;
  /** Applied to every failure reason after the API key is scrubbed; the job passes redactSecrets. */
  redact?: (s: string) => string;
}

const keyHeader = (apiKey: string): Record<string, string> => ({ "TRON-PRO-API-KEY": apiKey });
const postHeaders = (apiKey: string): Record<string, string> => ({ "content-type": "application/json", ...keyHeader(apiKey) });
const EMPTY_KEY = "API key is empty";

function num(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} missing or not a number`);
  return v;
}

function positive(v: unknown, name: string): number {
  const n = num(v, name);
  if (n <= 0) throw new Error(`${name} is not positive`);
  return n;
}

/** TronGrid answered 200 with an {"Error": ...} body (rate limit, bad address); carries its text, whitespace-collapsed. */
class UpstreamError extends Error {}

/** Throws UpstreamError when a parsed body is an object with an Error key. */
function throwIfError(o: object): void {
  if (!("Error" in o)) return;
  const e = (o as { Error: unknown }).Error;
  throw new UpstreamError((typeof e === "string" ? e : JSON.stringify(e) ?? String(e)).replace(/\s+/g, " ").trim());
}

/** The body of a real getaccountresource answer: a plain object, no Error key, and TotalEnergyLimit always present. */
function accountBody(text: string): Record<string, unknown> {
  const acc: unknown = JSON.parse(text);
  if (typeof acc !== "object" || acc === null || Array.isArray(acc)) throw new Error("body is not an object");
  const o = acc as Record<string, unknown>;
  throwIfError(o);
  num(o.TotalEnergyLimit, "TotalEnergyLimit");
  return o;
}

/** An absent field means zero (TronGrid omits zero values); a present one must be a finite number of at least zero. */
function optNonNegative(v: unknown, name: string): number {
  if (v === undefined) return 0;
  const n = num(v, name);
  if (n < 0) throw new Error(`${name} is negative`);
  return n;
}

/** Maps what a parser threw to a failure: TronGrid's own Error text, or a schema failure. */
function failParse(ctx: ChainContext, e: unknown): { ok: false; reason: string } {
  return e instanceof UpstreamError ? fail(ctx, "upstream error: ", e.message) : fail(ctx, `schema: ${errorMessage(e)}`);
}

const ERROR_TEXT_CHARS = 200;

/** The reason is `head` plus at most 200 characters of `tail`; the API key is scrubbed from both before the cut, so a cut never leaves part of it. */
function fail(ctx: ChainContext, head: string, tail = ""): { ok: false; reason: string } {
  const scrub = (t: string): string => (ctx.apiKey === "" ? t : t.split(ctx.apiKey).join("[redacted]"));
  let out = scrub(head) + scrub(tail).slice(0, ERROR_TEXT_CHARS);
  if (ctx.redact) {
    try {
      out = ctx.redact(out);
    } catch {
      out = "[redaction failed]";
    }
  }
  return { ok: false, reason: out };
}

export type ChainResult = { ok: true; params: ChainParams } | { ok: false; reason: string };

export async function readChainParams(ctx: ChainContext): Promise<ChainResult> {
  if (ctx.apiKey === "") return fail(ctx, EMPTY_KEY);
  const [p, a] = await Promise.all([
    fetchQuote(`${BASE}/wallet/getchainparameters`, { method: "GET", headers: keyHeader(ctx.apiKey) }, ctx.fetchOptions),
    fetchQuote(
      `${BASE}/wallet/getaccountresource`,
      { method: "POST", headers: postHeaders(ctx.apiKey), body: JSON.stringify({ address: WEIGHT_PROBE_ADDRESS, visible: true }) },
      ctx.fetchOptions,
    ),
  ]);
  if (!p.ok) return fail(ctx, `getchainparameters ${p.kind}: ${p.reason}`);
  if (!a.ok) return fail(ctx, `getaccountresource ${a.kind}: ${a.reason}`);
  try {
    const pBody: unknown = JSON.parse(p.body);
    if (typeof pBody !== "object" || pBody === null || Array.isArray(pBody)) throw new Error("body is not an object");
    throwIfError(pBody);
    const list = (pBody as { chainParameter?: { key: string; value?: number }[] }).chainParameter ?? [];
    const get = (key: string): number => positive(list.find((x) => x.key === key)?.value, key);
    const acc = accountBody(a.body);
    return {
      ok: true,
      params: {
        hour: ctx.hour,
        energyFeeSun: get("getEnergyFee"),
        totalEnergyLimit: get("getTotalEnergyLimit"),
        totalEnergyWeightTrx: positive(acc.TotalEnergyWeight, "TotalEnergyWeight"),
        trxUsd: null,
        readAt: ctx.now,
      },
    };
  } catch (e) {
    return failParse(ctx, e);
  }
}

export type ResourceResult = { ok: true; read: ResourceRead } | { ok: false; reason: string };

/** One wallet's energy allowance and use. Absent fields mean zero: TronGrid omits EnergyLimit for an account with no energy stake. */
export async function readAccountResource(wallet: string, ctx: ChainContext): Promise<ResourceResult> {
  if (ctx.apiKey === "") return fail(ctx, EMPTY_KEY);
  if (!TRON_ADDRESS.test(wallet)) return fail(ctx, "invalid address");
  const url = `${BASE}/wallet/getaccountresource`;
  const r = await fetchQuote(url, { method: "POST", headers: postHeaders(ctx.apiKey), body: JSON.stringify({ address: wallet, visible: true }) }, ctx.fetchOptions);
  if (!r.ok) return fail(ctx, `${r.kind}: ${r.reason}`);
  try {
    const acc = accountBody(r.body);
    return {
      ok: true,
      read: {
        hour: ctx.hour,
        wallet,
        energyLimit: optNonNegative(acc.EnergyLimit, "EnergyLimit"),
        energyUsed: optNonNegative(acc.EnergyUsed, "EnergyUsed"),
        readAt: ctx.now,
        source: url,
      },
    };
  } catch (e) {
    return failParse(ctx, e);
  }
}

export type EnergyStakeResult =
  | {
      ok: true;
      wallet: string;
      /** Own energy stake, kept and delegated out together. */
      energyStakeSun: number;
      /** The part of it delegated to other accounts (Stake 2.0 and Stake 1.0 delegations): its energy is used by the recipients. */
      delegatedOutSun: number;
      source: string;
    }
  | { ok: false; reason: string };

/**
 * One account's own energy stake, in sun, from `wallet/getaccount`: its `frozenV2` entry of type ENERGY plus
 * `account_resource.delegated_frozenV2_balance_for_energy` (energy it staked and delegated out still counts in
 * TotalEnergyWeight, and moves out of frozenV2 when delegated), plus the Stake 1.0 fields when present
 * (`account_resource.frozen_balance_for_energy.frozen_balance`, `account_resource.delegated_frozen_balance_for_energy`).
 * Absent fields mean zero. An answer without the account's own address (TronGrid returns {} for an unknown account) is a failure.
 */
export async function readAccountEnergyStake(wallet: string, ctx: ChainContext): Promise<EnergyStakeResult> {
  if (ctx.apiKey === "") return fail(ctx, EMPTY_KEY);
  if (!TRON_ADDRESS.test(wallet)) return fail(ctx, "invalid address");
  const url = `${BASE}/wallet/getaccount`;
  const r = await fetchQuote(url, { method: "POST", headers: postHeaders(ctx.apiKey), body: JSON.stringify({ address: wallet, visible: true }) }, ctx.fetchOptions);
  if (!r.ok) return fail(ctx, `${r.kind}: ${r.reason}`);
  try {
    const acc: unknown = JSON.parse(r.body);
    if (typeof acc !== "object" || acc === null || Array.isArray(acc)) throw new Error("body is not an object");
    const o = acc as Record<string, unknown>;
    throwIfError(o);
    if (o.address !== wallet) throw new Error("address missing or not the one asked for");
    let frozen = 0;
    if (o.frozenV2 !== undefined) {
      if (!Array.isArray(o.frozenV2)) throw new Error("frozenV2 is not an array");
      for (const f of o.frozenV2 as unknown[]) {
        if (typeof f !== "object" || f === null) throw new Error("frozenV2 entry is not an object");
        const e = f as Record<string, unknown>;
        if (e.type === "ENERGY") frozen += optNonNegative(e.amount, "frozenV2 ENERGY amount");
      }
    }
    let kept = 0;
    let delegatedOut = 0;
    if (o.account_resource !== undefined) {
      if (typeof o.account_resource !== "object" || o.account_resource === null) throw new Error("account_resource is not an object");
      const ar = o.account_resource as Record<string, unknown>;
      delegatedOut += optNonNegative(ar.delegated_frozenV2_balance_for_energy, "delegated_frozenV2_balance_for_energy");
      // Stake 1.0, still counted in TotalEnergyWeight until unfrozen: own frozen energy and energy frozen for another account.
      if (ar.frozen_balance_for_energy !== undefined) {
        if (typeof ar.frozen_balance_for_energy !== "object" || ar.frozen_balance_for_energy === null) throw new Error("frozen_balance_for_energy is not an object");
        kept += optNonNegative((ar.frozen_balance_for_energy as Record<string, unknown>).frozen_balance, "frozen_balance_for_energy.frozen_balance");
      }
      delegatedOut += optNonNegative(ar.delegated_frozen_balance_for_energy, "delegated_frozen_balance_for_energy");
    }
    return { ok: true, wallet, energyStakeSun: frozen + kept + delegatedOut, delegatedOutSun: delegatedOut, source: url };
  } catch (e) {
    return failParse(ctx, e);
  }
}
