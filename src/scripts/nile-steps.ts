import type { TronWeb, Types } from "tronweb";
import { SUN_PER_TRX } from "../core/types.js";
import { assertNileGenesis, chainErrorText, decodeChainMessage, journalLine, type NileCommand, type NileEnv } from "./nile.js";

/**
 * The probe's steps over the few TronWeb methods they use, so a test can drive them with a fake and check the order of
 * calls. Every read asks the fullnode for the latest state (`confirmed: false`, or the unconfirmed account), not the
 * solidity node TronWeb 6 defaults some reads to, and says so in the journal line.
 */
export interface ProbeTron {
  defaultAddress: { base58: string | false };
  trx: Pick<TronWeb["trx"], "getBlockByNumber" | "getUnconfirmedAccount" | "getCanDelegatedMaxSize" | "getDelegatedResourceV2" | "sign" | "sendRawTransaction">;
  transactionBuilder: Pick<TronWeb["transactionBuilder"], "delegateResource" | "undelegateResource" | "triggerConstantContract">;
}

export interface ProbeDeps {
  tron: ProbeTron;
  command: NileCommand;
  cfg: NileEnv;
  now: () => Date;
  /** Appends the journal line and prints it. */
  write: (line: string) => void;
  /** For redaction; it must already hold the key in every form (keyRedactionEnv). */
  env: NodeJS.ProcessEnv;
}

interface StepResult {
  data: Record<string, unknown>;
  ok: boolean;
}

/** Latest state, not the solidity node's confirmed one. */
const LATEST = { confirmed: false } as const;

const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

/**
 * One step. First, always, block 0 is read and must be Nile's genesis block (a ConfigError otherwise, before any other call
 * and before anything is signed). Then the step runs and its one journal line is written. Returns the exit code: 0, or 1
 * when the step was refused or the chain rejected it.
 */
export async function runProbe(d: ProbeDeps): Promise<number> {
  const genesis = await d.tron.trx.getBlockByNumber(0);
  assertNileGenesis(genesis.blockID);
  const me = d.tron.defaultAddress.base58;
  if (!me) throw new Error("no address derived from NILE_PRIVATE_KEY");
  const { command, cfg } = d;
  const { data, ok } = await runStep(d.tron, me, cfg, command);
  const args = command.step === "delegate" ? { lockBlocks: command.lockBlocks, amountTrx: cfg.amountTrx } : command.step === "undelegate" ? { amountTrx: cfg.amountTrx } : {};
  d.write(journalLine(d.now(), command.step, args, data, d.env));
  return ok ? 0 : 1;
}

async function delegations(tron: ProbeTron, me: string, receiver: string) {
  const r = await tron.trx.getDelegatedResourceV2(me, receiver, LATEST);
  const list = (r.delegatedResource ?? []).map((x) => ({
    frozenBalanceForEnergySun: x.frozen_balance_for_energy ?? 0,
    expireTimeForEnergy: x.expire_time_for_energy ?? 0,
    expireTimeForEnergyUtc: iso(x.expire_time_for_energy ?? 0),
  }));
  return { confirmed: false, list };
}

async function canDelegate(tron: ProbeTron, me: string) {
  const r = await tron.trx.getCanDelegatedMaxSize(me, "ENERGY", LATEST);
  return { confirmed: false, maxSun: r.max_size ?? 0 };
}

/** Builds, signs and broadcasts one transaction; the chain's answer, or the error as text, is the result. */
async function broadcast(tron: ProbeTron, build: () => Promise<Types.Transaction>): Promise<StepResult> {
  try {
    const tx = await build();
    const signed = await tron.trx.sign(tx);
    const r = await tron.trx.sendRawTransaction(signed);
    return { ok: r.result === true, data: { result: r.result === true, txid: r.txid ?? null, code: r.code ?? null, message: decodeChainMessage(r.message) } };
  } catch (e) {
    return { ok: false, data: { result: false, error: chainErrorText(e) } };
  }
}

/** A view call on the probe contract against the latest state: the uint256 it returns, as a decimal string, or the error text. */
async function probeView(tron: ProbeTron, probe: string, fn: "delegated" | "reverse", receiver: string, from: string, me: string): Promise<{ value: string | null; error?: string }> {
  try {
    const r = await tron.transactionBuilder.triggerConstantContract(probe, `${fn}(address,address)`, { ...LATEST }, [{ type: "address", value: receiver }, { type: "address", value: from }], me);
    const hex: unknown = Array.isArray(r.constant_result) ? r.constant_result[0] : undefined;
    if (r.result?.result !== true || typeof hex !== "string" || !/^[0-9a-fA-F]+$/.test(hex)) return { value: null, error: decodeChainMessage(r.result?.message) ?? "no constant result" };
    return { value: BigInt(`0x${hex}`).toString() };
  } catch (e) {
    return { value: null, error: chainErrorText(e) };
  }
}

async function runStep(tron: ProbeTron, me: string, cfg: NileEnv, command: NileCommand): Promise<StepResult> {
  const amountSun = cfg.amountTrx * SUN_PER_TRX;
  switch (command.step) {
    case "status": {
      const account = await tron.trx.getUnconfirmedAccount(me);
      const frozenV2EnergySun = (account.frozenV2 ?? []).filter((f) => f.type === "ENERGY").reduce((s, f) => s + (f.amount ?? 0), 0);
      return {
        ok: true,
        data: { address: me, receiver: cfg.receiver, account: { confirmed: false, frozenV2EnergySun }, canDelegate: await canDelegate(tron, me), delegations: await delegations(tron, me, cfg.receiver) },
      };
    }
    case "delegate": {
      const can = await canDelegate(tron, me);
      if (amountSun > can.maxSun) return { ok: false, data: { refused: "the amount exceeds what the wallet can delegate", amountSun, canDelegate: can } };
      const r = await broadcast(tron, () => tron.transactionBuilder.delegateResource(amountSun, cfg.receiver, "ENERGY", me, true, command.lockBlocks));
      return { ok: r.ok, data: { amountSun, lockBlocks: command.lockBlocks, canDelegate: can, ...r.data } };
    }
    case "undelegate": {
      const r = await broadcast(tron, () => tron.transactionBuilder.undelegateResource(amountSun, cfg.receiver, "ENERGY", me));
      return { ok: r.ok, data: { amountSun, ...r.data } };
    }
    case "read": {
      const data: Record<string, unknown> = { delegations: await delegations(tron, me, cfg.receiver) };
      if (cfg.probeAddress === null) {
        data.probe = "skipped: NILE_PROBE_ADDRESS is not set, so resourceV2 was not read";
      } else {
        data.probe = {
          confirmed: false,
          "receiver.resourceV2(from, 1)": await probeView(tron, cfg.probeAddress, "delegated", cfg.receiver, me, me),
          "from.resourceV2(receiver, 1)": await probeView(tron, cfg.probeAddress, "reverse", cfg.receiver, me, me),
        };
      }
      return { ok: true, data };
    }
  }
}
