import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TronWeb } from "tronweb";
import { redactSecrets } from "../../src/index/redact.js";
import { errorLine } from "../../src/scripts/exit.js";
import {
  DEFAULT_AMOUNT_TRX,
  MAX_AMOUNT_TRX,
  MAX_LOCK_BLOCKS,
  NILE_FULL_HOST,
  NILE_GENESIS_BLOCK_ID,
  assertNileGenesis,
  chainErrorText,
  constructTron,
  decodeChainMessage,
  journalLine,
  keyRedactionEnv,
  nileEnv,
  parseNileArgs,
} from "../../src/scripts/nile.js";
import { runProbe, type ProbeTron } from "../../src/scripts/nile-steps.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tsx = `${root}node_modules/.bin/tsx`;
const noNetwork = fileURLToPath(new URL("../fixtures/no-network.mjs", import.meta.url));
const spawn = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd: root, env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--import ${noNetwork}`, ...env }, encoding: "utf8", timeout: 30_000 });

/** A made-up key in the right shape; never a real one. */
const KEY = "ab".repeat(32);
const RECEIVER = `T${"N".repeat(33)}`;
const PROBE = `T${"P".repeat(33)}`;
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ NILE_PRIVATE_KEY: KEY, NILE_RECEIVER: RECEIVER, ...over });
const configError = expect.objectContaining({ name: "ConfigError" });

describe("parseNileArgs", () => {
  it("status, delegate <lockBlocks>, undelegate, read", () => {
    expect(parseNileArgs(["status"])).toEqual({ step: "status" });
    expect(parseNileArgs(["delegate", "1"])).toEqual({ step: "delegate", lockBlocks: 1 });
    expect(parseNileArgs(["delegate", "1200"])).toEqual({ step: "delegate", lockBlocks: 1200 });
    expect(parseNileArgs(["delegate", String(MAX_LOCK_BLOCKS)])).toEqual({ step: "delegate", lockBlocks: 864_000 });
    expect(parseNileArgs(["undelegate"])).toEqual({ step: "undelegate" });
    expect(parseNileArgs(["read"])).toEqual({ step: "read" });
  });
  it("a ConfigError for no step, an unknown step, extra arguments, a host flag, and lockBlocks outside 1..864000 or not an integer", () => {
    for (const bad of [[], ["probe"], ["status", "x"], ["read", "--full-host", "https://api.trongrid.io"], ["--full-host=https://api.trongrid.io", "status"], ["delegate"], ["delegate", "0"], ["delegate", "864001"], ["delegate", "-1"], ["delegate", "1.5"], ["delegate", "1e3"], ["delegate", "abc"], ["delegate", "1", "2"], ["undelegate", "1"]]) {
      expect(() => parseNileArgs(bad), JSON.stringify(bad)).toThrow(configError);
    }
  });
});

describe("nileEnv", () => {
  it("needs NILE_PRIVATE_KEY and NILE_RECEIVER; NILE_PROBE_ADDRESS is optional; NILE_AMOUNT_TRX defaults to 100", () => {
    expect(nileEnv(env())).toEqual({ privateKey: KEY, receiver: RECEIVER, probeAddress: null, amountTrx: DEFAULT_AMOUNT_TRX });
    expect(DEFAULT_AMOUNT_TRX).toBe(100);
    expect(nileEnv(env({ NILE_PROBE_ADDRESS: PROBE, NILE_AMOUNT_TRX: "250" }))).toEqual({ privateKey: KEY, receiver: RECEIVER, probeAddress: PROBE, amountTrx: 250 });
    expect(nileEnv(env({ NILE_PRIVATE_KEY: ` 0x${KEY.toUpperCase()} ` })).privateKey).toBe(KEY.toUpperCase());
    expect(nileEnv(env({ NILE_AMOUNT_TRX: String(MAX_AMOUNT_TRX) })).amountTrx).toBe(10_000);
  });
  it("a missing key, or one that is not 64 hex characters, is a ConfigError that never echoes the value", () => {
    expect(() => nileEnv(env({ NILE_PRIVATE_KEY: undefined }))).toThrow("NILE_PRIVATE_KEY is required");
    expect(() => nileEnv(env({ NILE_PRIVATE_KEY: "  " }))).toThrow("NILE_PRIVATE_KEY is required");
    for (const bad of [KEY.slice(1), `${KEY}a`, `zz${KEY.slice(2)}`, "mnemonic words are not a key at all ok"]) {
      let message = "";
      try {
        nileEnv(env({ NILE_PRIVATE_KEY: bad }));
      } catch (e) {
        expect(e).toEqual(configError);
        message = (e as Error).message;
      }
      expect(message).toBe("NILE_PRIVATE_KEY must be 64 hex characters");
    }
  });
  it("a receiver or probe address that is not a base58 Tron address (T, 34 characters, base58 alphabet) is a ConfigError", () => {
    expect(() => nileEnv(env({ NILE_RECEIVER: undefined }))).toThrow("NILE_RECEIVER is required");
    for (const bad of [RECEIVER.slice(1), `${RECEIVER}N`, `A${"N".repeat(33)}`, `T${"0".repeat(33)}`, `T${"O".repeat(33)}`, `T${"I".repeat(33)}`, `T${"l".repeat(33)}`, "41" + "a".repeat(40)]) {
      expect(() => nileEnv(env({ NILE_RECEIVER: bad })), bad).toThrow(configError);
      expect(() => nileEnv(env({ NILE_PROBE_ADDRESS: bad })), bad).toThrow(configError);
    }
  });
  it("NILE_AMOUNT_TRX must be a whole number from 1 to 10000", () => {
    for (const bad of ["0", "-1", "1.5", "10001", "abc", "1e3", ""]) {
      if (bad === "") continue; // empty means unset: the default
      expect(() => nileEnv(env({ NILE_AMOUNT_TRX: bad })), bad).toThrow(configError);
    }
    expect(nileEnv(env({ NILE_AMOUNT_TRX: "" })).amountTrx).toBe(100);
  });
  it("no variable can change the host", () => {
    expect(NILE_FULL_HOST).toBe("https://nile.trongrid.io");
    expect(nileEnv(env({ NILE_FULL_HOST: "https://api.trongrid.io", FULL_HOST: "https://api.trongrid.io" }))).not.toHaveProperty("fullHost");
    const source = readFileSync(new URL("../../src/scripts/nile-probe.ts", import.meta.url), "utf8");
    expect(source).toContain("fullHost: NILE_FULL_HOST");
    expect(source).not.toMatch(/process\.env\.\w*HOST/);
  });
});

describe("the Nile check", () => {
  it("accepts only Nile's genesis block id", () => {
    expect(NILE_GENESIS_BLOCK_ID).toBe("0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc");
    expect(() => assertNileGenesis(NILE_GENESIS_BLOCK_ID)).not.toThrow();
    // Mainnet's and Shasta's genesis ids, a missing id, and a non-string.
    for (const other of ["00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc", "0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e", undefined, "", 0]) {
      expect(() => assertNileGenesis(other)).toThrow(configError);
    }
  });
});

describe("journal lines", () => {
  it("one JSON line {at, step, args, data}, with a fake NILE_PRIVATE_KEY removed wherever it appears", () => {
    const line = journalLine(new Date(0), "delegate", { lockBlocks: 1 }, { error: `bad signature with ${KEY}` }, { NILE_PRIVATE_KEY: KEY });
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ at: "1970-01-01T00:00:00.000Z", step: "delegate", args: { lockBlocks: 1 }, data: { error: "bad signature with [redacted]" } });
    expect(redactSecrets(`{"k":"${KEY}"}`, { NILE_PRIVATE_KEY: KEY })).toBe('{"k":"[redacted]"}');
  });
  it("chain errors are recorded as text: a string as is, an Error as name and message, anything else only by its message or code", () => {
    expect(chainErrorText("Contract validate error : lock period too short")).toBe("Contract validate error : lock period too short");
    expect(chainErrorText(new TypeError("boom"))).toBe("TypeError: boom");
    expect(chainErrorText({ code: "CONTRACT_VALIDATE_ERROR", message: "too short", config: { privateKey: KEY } })).toBe("CONTRACT_VALIDATE_ERROR: too short");
    expect(chainErrorText({ config: { privateKey: KEY } })).toBe("unprintable error");
    expect(chainErrorText("x".repeat(2000))).toHaveLength(500);
  });
  it("decodes a hex broadcast message to text, leaving anything else as it is", () => {
    expect(decodeChainMessage(Buffer.from("Contract validate error : too short").toString("hex"))).toBe("Contract validate error : too short");
    expect(decodeChainMessage("plain text")).toBe("plain text");
    expect(decodeChainMessage("")).toBe("");
    expect(decodeChainMessage(undefined)).toBeNull();
  });
});

describe("the key in every form it is used", () => {
  it("a key given with 0X and in upper case is redacted in either letter case, in the journal line and in errorLine", () => {
    const given = env({ NILE_PRIVATE_KEY: `0X${KEY.toUpperCase()}` });
    const cfg = nileEnv(given);
    const redactEnv = { ...given, ...keyRedactionEnv(cfg.privateKey) };
    expect(Object.keys(keyRedactionEnv(cfg.privateKey)).sort()).toEqual(["NILE_PRIVATE_KEY_AS_USED", "NILE_PRIVATE_KEY_LOWER", "NILE_PRIVATE_KEY_UPPER"]);
    const line = journalLine(new Date(0), "status", {}, { a: `lower ${KEY}`, b: `upper ${KEY.toUpperCase()}` }, redactEnv);
    expect(line.toLowerCase()).not.toContain(KEY);
    expect(JSON.parse(line).data).toEqual({ a: "lower [redacted]", b: "upper [redacted]" });
    const err = errorLine(new Error(`bad key ${KEY} / ${KEY.toUpperCase()}`), redactEnv);
    expect(err).toBe("Error: bad key [redacted] / [redacted]");
  });
  it("constructTron turns TronWeb's invalid-key error into a ConfigError and passes anything else on", () => {
    expect(() => constructTron(() => new TronWeb({ fullHost: NILE_FULL_HOST, privateKey: "0".repeat(64) }))).toThrow(expect.objectContaining({ name: "ConfigError", message: "NILE_PRIVATE_KEY is not a valid private key" }));
    expect(() => constructTron(() => { throw new Error("other"); })).toThrow("other");
    expect(constructTron(() => 7)).toBe(7);
  });
});

/** A fake TronWeb that records every call in order; only the methods runProbe may use exist. */
function fakeTron(o: { genesis?: string; maxSun?: number; sendResult?: boolean; delegateThrows?: unknown } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec = (name: string, value: unknown) => async (...args: unknown[]) => {
    calls.push({ name, args });
    if (typeof value === "function") return (value as () => unknown)();
    return value;
  };
  const tron = {
    defaultAddress: { hex: "41", base58: `T${"M".repeat(33)}` },
    trx: {
      getBlockByNumber: rec("getBlockByNumber", { blockID: o.genesis ?? NILE_GENESIS_BLOCK_ID }),
      getUnconfirmedAccount: rec("getUnconfirmedAccount", { frozenV2: [{ type: "ENERGY", amount: 500_000_000 }, { amount: 7 }] }),
      getCanDelegatedMaxSize: rec("getCanDelegatedMaxSize", { max_size: o.maxSun ?? 1_000_000_000 }),
      getDelegatedResourceV2: rec("getDelegatedResourceV2", { delegatedResource: [{ frozen_balance_for_energy: 100_000_000, expire_time_for_energy: 1_800_000_000_000 }] }),
      sign: rec("sign", { signed: true }),
      sendRawTransaction: rec("sendRawTransaction", { result: o.sendResult ?? true, txid: "tx1", code: o.sendResult === false ? "CONTRACT_VALIDATE_ERROR" : undefined, message: o.sendResult === false ? Buffer.from("lock period too short").toString("hex") : undefined }),
    },
    transactionBuilder: {
      delegateResource: rec("delegateResource", () => {
        if (o.delegateThrows !== undefined) throw o.delegateThrows;
        return { tx: "d" };
      }),
      undelegateResource: rec("undelegateResource", { tx: "u" }),
      triggerConstantContract: rec("triggerConstantContract", { result: { result: true }, constant_result: ["0000000000000000000000000000000000000000000000000000000005f5e100"] }),
    },
  };
  return { tron: tron as unknown as ProbeTron, calls, names: () => calls.map((c) => c.name) };
}

describe("runProbe", () => {
  const cfg = (over: Partial<ReturnType<typeof nileEnv>> = {}) => ({ privateKey: KEY, receiver: RECEIVER, probeAddress: null, amountTrx: 100, ...over });
  const deps = (f: ReturnType<typeof fakeTron>, command: Parameters<typeof runProbe>[0]["command"], c = cfg()) => {
    const lines: string[] = [];
    return { lines, d: { tron: f.tron, command, cfg: c, now: () => new Date(0), write: (l: string) => lines.push(l), env: { NILE_PRIVATE_KEY: KEY } } };
  };

  it("checks the genesis block before anything else; a node that is not Nile is refused with no other call and nothing written", async () => {
    const f = fakeTron({ genesis: "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc" });
    const { lines, d } = deps(f, { step: "delegate", lockBlocks: 1200 });
    await expect(runProbe(d)).rejects.toMatchObject({ name: "ConfigError" });
    expect(f.names()).toEqual(["getBlockByNumber"]);
    expect(f.calls[0]!.args).toEqual([0]);
    expect(lines).toEqual([]);
  });

  it("delegate: genesis, then an unconfirmed can-delegate read, then build, sign and send, in that order", async () => {
    const f = fakeTron();
    const { lines, d } = deps(f, { step: "delegate", lockBlocks: 1200 });
    expect(await runProbe(d)).toBe(0);
    expect(f.names()).toEqual(["getBlockByNumber", "getCanDelegatedMaxSize", "delegateResource", "sign", "sendRawTransaction"]);
    expect(f.calls[1]!.args).toEqual([`T${"M".repeat(33)}`, "ENERGY", { confirmed: false }]);
    expect(f.calls[2]!.args).toEqual([100_000_000, RECEIVER, "ENERGY", `T${"M".repeat(33)}`, true, 1200]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      step: "delegate",
      args: { lockBlocks: 1200, amountTrx: 100 },
      data: { amountSun: 100_000_000, lockBlocks: 1200, canDelegate: { confirmed: false, maxSun: 1_000_000_000 }, result: true, txid: "tx1", code: null, message: null },
    });
  });

  it("delegate above the can-delegate maximum is refused before anything is built or signed: exit 1, one line", async () => {
    const f = fakeTron({ maxSun: 50_000_000 });
    const { lines, d } = deps(f, { step: "delegate", lockBlocks: 1 });
    expect(await runProbe(d)).toBe(1);
    expect(f.names()).toEqual(["getBlockByNumber", "getCanDelegatedMaxSize"]);
    expect(JSON.parse(lines[0]!).data).toMatchObject({ refused: expect.any(String), amountSun: 100_000_000, canDelegate: { confirmed: false, maxSun: 50_000_000 } });
  });

  it("a rejected broadcast records the decoded chain message; a thrown error object is recorded as text only", async () => {
    const rejected = fakeTron({ sendResult: false });
    const a = deps(rejected, { step: "undelegate" });
    expect(await runProbe(a.d)).toBe(1);
    expect(rejected.names()).toEqual(["getBlockByNumber", "undelegateResource", "sign", "sendRawTransaction"]);
    expect(JSON.parse(a.lines[0]!).data).toEqual({ amountSun: 100_000_000, result: false, txid: "tx1", code: "CONTRACT_VALIDATE_ERROR", message: "lock period too short" });
    const thrown = fakeTron({ delegateThrows: { message: "validate error", request: { privateKey: KEY } } });
    const b = deps(thrown, { step: "delegate", lockBlocks: 1 });
    expect(await runProbe(b.d)).toBe(1);
    expect(thrown.names()).not.toContain("sign");
    expect(b.lines[0]).not.toContain(KEY);
    expect(JSON.parse(b.lines[0]!).data).toMatchObject({ result: false, error: "validate error" });
  });

  it("status reads the latest state: the unconfirmed account, can-delegate and delegations, each marked confirmed: false", async () => {
    const f = fakeTron();
    const { lines, d } = deps(f, { step: "status" });
    expect(await runProbe(d)).toBe(0);
    expect(f.names()).toEqual(["getBlockByNumber", "getUnconfirmedAccount", "getCanDelegatedMaxSize", "getDelegatedResourceV2"]);
    expect(f.calls[3]!.args).toEqual([`T${"M".repeat(33)}`, RECEIVER, { confirmed: false }]);
    expect(JSON.parse(lines[0]!).data).toEqual({
      address: `T${"M".repeat(33)}`,
      receiver: RECEIVER,
      account: { confirmed: false, frozenV2EnergySun: 500_000_000 },
      canDelegate: { confirmed: false, maxSun: 1_000_000_000 },
      delegations: { confirmed: false, list: [{ frozenBalanceForEnergySun: 100_000_000, expireTimeForEnergy: 1_800_000_000_000, expireTimeForEnergyUtc: "2027-01-15T08:00:00.000Z" }] },
    });
  });

  it("read: delegations, and the probe's two views only when NILE_PROBE_ADDRESS is set", async () => {
    const f = fakeTron();
    const a = deps(f, { step: "read" });
    expect(await runProbe(a.d)).toBe(0);
    expect(f.names()).toEqual(["getBlockByNumber", "getDelegatedResourceV2"]);
    expect(JSON.parse(a.lines[0]!).data.probe).toMatch(/^skipped/);
    const g = fakeTron();
    const b = deps(g, { step: "read" }, cfg({ probeAddress: PROBE }));
    expect(await runProbe(b.d)).toBe(0);
    expect(g.names()).toEqual(["getBlockByNumber", "getDelegatedResourceV2", "triggerConstantContract", "triggerConstantContract"]);
    expect(g.calls[2]!.args).toEqual([PROBE, "delegated(address,address)", { confirmed: false }, [{ type: "address", value: RECEIVER }, { type: "address", value: `T${"M".repeat(33)}` }], `T${"M".repeat(33)}`]);
    expect(g.calls[3]!.args[1]).toBe("reverse(address,address)");
    expect(JSON.parse(b.lines[0]!).data.probe).toEqual({
      confirmed: false,
      "receiver.resourceV2(from, 1)": { value: "100000000" },
      "from.resourceV2(receiver, 1)": { value: "100000000" },
    });
  });
});

describe("nile-probe without configuration", () => {
  it("the no-network guard catches a network call: fetch, dns resolve, a Resolver, dns.promises and UDP", () => {
    for (const code of [
      'fetch("https://nile.trongrid.io").catch(() => process.exit(3))',
      'try { require("node:dns").resolve4("nile.trongrid.io", () => {}) } catch {}',
      'try { new (require("node:dns").Resolver)() } catch {}',
      'require("node:dns").promises.resolve4("nile.trongrid.io").catch(() => {})',
      'try { new (require("node:dns").promises.Resolver)() } catch {}',
      'try { require("node:dgram").createSocket("udp4") } catch {}',
    ]) {
      expect(spawn(process.execPath, ["-e", code]).stderr, code).toContain("NETWORK-CALL-BLOCKED");
    }
  });
  it("an empty environment exits 2 before any network call, naming the missing variable", () => {
    const r = spawn(tsx, ["src/scripts/nile-probe.ts", "status"], { ENV_FILE: "/nonexistent/.env" });
    expect(r.stderr).not.toContain("NETWORK-CALL-BLOCKED");
    expect(r.stderr.trim()).toBe("ConfigError: NILE_PRIVATE_KEY is required");
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });
  it("a key TronWeb rejects (all zeros) exits 2 before any network call, without echoing it", () => {
    const zero = "0".repeat(64);
    const r = spawn(tsx, ["src/scripts/nile-probe.ts", "status"], { ENV_FILE: "/nonexistent/.env", NILE_PRIVATE_KEY: zero, NILE_RECEIVER: RECEIVER });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe("ConfigError: NILE_PRIVATE_KEY is not a valid private key");
    expect(r.stderr).not.toContain("NETWORK-CALL-BLOCKED");
  });
  it("with a valid environment it makes a network call, which the guard blocks: exit 1, nothing printed, no journal line", () => {
    const journal = new URL("../../docs/verification/nile-lock.jsonl", import.meta.url);
    const before = existsSync(journal) ? readFileSync(journal, "utf8") : null;
    // Belt and braces: a proxy on a closed local port, so even an unguarded request could not leave the machine.
    const r = spawn(tsx, ["src/scripts/nile-probe.ts", "delegate", "1"], { ENV_FILE: "/nonexistent/.env", NILE_PRIVATE_KEY: KEY, NILE_RECEIVER: RECEIVER, HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" });
    expect(r.stderr).toContain("NETWORK-CALL-BLOCKED");
    expect(r.stderr).not.toContain(KEY);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(existsSync(journal) ? readFileSync(journal, "utf8") : null).toBe(before);
  });
  it("a bad step exits 2 before reading the environment; a bad receiver exits 2 without echoing the key", () => {
    const bad = spawn(tsx, ["src/scripts/nile-probe.ts", "delegate", "0"], { ENV_FILE: "/nonexistent/.env" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).not.toContain("NETWORK-CALL-BLOCKED");
    const r = spawn(tsx, ["src/scripts/nile-probe.ts", "status"], { ENV_FILE: "/nonexistent/.env", NILE_PRIVATE_KEY: KEY, NILE_RECEIVER: "nope" });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain("NETWORK-CALL-BLOCKED");
    expect(r.stderr).not.toContain(KEY);
    expect(r.stdout).toBe("");
  });
});
