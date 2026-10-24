import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readAccountEnergyStake, readAccountResource, readChainParams } from "../../src/collectors/chain.js";

const params = readFileSync(new URL("../fixtures/trongrid-chainparameters.json", import.meta.url), "utf8");
const account = readFileSync(new URL("../fixtures/trongrid-accountresource.json", import.meta.url), "utf8");
const opts = { budgetMs: 1000, retryAtMs: 500 };
const WALLET = "TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd";
const RATE_LIMIT = "request rate exceeded the allowed_rps(3), and the query server is suspended for 5 s.";
const KEY = "test-key-0123456789";

/** Answers each known URL with its body (404 otherwise) and remembers the init of the last request answered. */
function byUrl(map: Record<string, string>): { fetchImpl: typeof fetch; lastInit: () => RequestInit | undefined } {
  let last: RequestInit | undefined;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = map[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    last = init;
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, lastInit: () => last };
}

const BOTH = { "https://api.trongrid.io/wallet/getchainparameters": params, "https://api.trongrid.io/wallet/getaccountresource": account };
const ACCOUNT_URL = "https://api.trongrid.io/wallet/getaccountresource";
const ctxFor = (fetchImpl: typeof fetch) => ({ hour: 1, now: new Date("2026-10-28T14:00:00Z"), apiKey: KEY, fetchOptions: { ...opts, fetchImpl } });

describe("readChainParams", () => {
  it("returns the fee, the limit and the weight", async () => {
    const r = await readChainParams(ctxFor(byUrl(BOTH).fetchImpl));
    expect(r).toMatchObject({ ok: true, params: { hour: 1, energyFeeSun: 100, totalEnergyLimit: 180_000_000_000, totalEnergyWeightTrx: 18_538_236_074, trxUsd: null } });
  });
  it("sends the API key header", async () => {
    const f = byUrl(BOTH);
    await readChainParams(ctxFor(f.fetchImpl));
    expect((f.lastInit()?.headers as Record<string, string>)["TRON-PRO-API-KEY"]).toBe(KEY);
  });
  it("sends the key on both requests, with the right method and body", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(BOTH[String(url) as keyof typeof BOTH], { status: 200 });
    }) as unknown as typeof fetch;
    await readChainParams(ctxFor(fetchImpl));
    expect(seen).toHaveLength(2);
    for (const s of seen) expect((s.init?.headers as Record<string, string>)["TRON-PRO-API-KEY"]).toBe(KEY);
    const get = seen.find((s) => s.url.endsWith("getchainparameters"))!;
    const post = seen.find((s) => s.url.endsWith("getaccountresource"))!;
    expect(get.init?.method).toBe("GET");
    expect(Object.keys(get.init?.headers as Record<string, string>)).toEqual(["TRON-PRO-API-KEY"]);
    expect(post.init?.method).toBe("POST");
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ visible: true });
  });
  it("fails fast on an empty key without calling the network", async () => {
    const f = byUrl(BOTH);
    const r = await readChainParams({ ...ctxFor(f.fetchImpl), apiKey: "" });
    expect(r).toEqual({ ok: false, reason: "API key is empty" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(0);
  });
  it("reports a failure of the second call", async () => {
    const r = await readChainParams(ctxFor(byUrl({ "https://api.trongrid.io/wallet/getchainparameters": params }).fetchImpl));
    expect(r.ok === false && r.reason).toMatch(/^getaccountresource upstream: 404/);
  });
  it("scrubs the API key from a reason even without a redactor", async () => {
    const fetchImpl = (async () => new Response("bad key SECRETKEY123", { status: 401 })) as unknown as typeof fetch;
    const r = await readChainParams({ ...ctxFor(fetchImpl), apiKey: "SECRETKEY123" });
    expect(r.ok === false && r.reason).toMatch(/401/);
    expect(r.ok === false && r.reason).not.toContain("SECRETKEY123");
  });
  it("rejects a zero or negative fee, limit or weight, and an error body for the weight call", async () => {
    const P = "https://api.trongrid.io/wallet/getchainparameters";
    const cases: [string, string, string][] = [
      [P, params.replace('"value":100', '"value":0'), "getEnergyFee"],
      [P, params.replace('"value":100', '"value":-1'), "getEnergyFee"],
      [P, params.replaceAll('"value":180000000000', '"value":0'), "getTotalEnergyLimit"],
      [ACCOUNT_URL, account.replace("18538236074", "0"), "TotalEnergyWeight"],
      [ACCOUNT_URL, account.replace("18538236074", "-5"), "TotalEnergyWeight"],
    ];
    for (const [url, body, what] of cases) {
      const r = await readChainParams(ctxFor(byUrl({ ...BOTH, [url]: body }).fetchImpl));
      expect(r.ok === false && r.reason).toMatch(/^schema:/);
      expect(r.ok === false && r.reason).toContain(what);
    }
  });
  it("reports TronGrid's Error text from either call", async () => {
    const P = "https://api.trongrid.io/wallet/getchainparameters";
    const limited = JSON.stringify({ Error: RATE_LIMIT });
    for (const url of [P, ACCOUNT_URL]) {
      const r = await readChainParams(ctxFor(byUrl({ ...BOTH, [url]: limited }).fetchImpl));
      expect(r).toEqual({ ok: false, reason: `upstream error: ${RATE_LIMIT}` });
    }
    const arr = await readChainParams(ctxFor(byUrl({ ...BOTH, [P]: "[]" }).fetchImpl));
    expect(arr.ok === false && arr.reason).toMatch(/^schema:/);
  });
  it("reports a failure with the helper's reason", async () => {
    const r = await readChainParams(ctxFor(byUrl({}).fetchImpl));
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.reason).toMatch(/404/);
  });
  it("reports a missing or non-numeric field as a schema error", async () => {
    const noFee = params.replace("getEnergyFee", "other");
    const a = await readChainParams(ctxFor(byUrl({ ...BOTH, "https://api.trongrid.io/wallet/getchainparameters": noFee }).fetchImpl));
    expect(a).toMatchObject({ ok: false });
    expect(a.ok === false && a.reason).toMatch(/schema.*getEnergyFee/);
    const stringWeight = account.replace("18538236074", '"18538236074"');
    const b = await readChainParams(ctxFor(byUrl({ ...BOTH, [ACCOUNT_URL]: stringWeight }).fetchImpl));
    expect(b.ok === false && b.reason).toMatch(/schema.*TotalEnergyWeight/);
  });
});

describe("readAccountResource", () => {
  it("reads EnergyLimit and EnergyUsed, defaulting absent fields to zero", async () => {
    const f = byUrl({ [ACCOUNT_URL]: '{"freeNetLimit":600,"TotalEnergyLimit":180000000000,"TotalEnergyWeight":1}' });
    const r = await readAccountResource(WALLET, ctxFor(f.fetchImpl));
    expect(r).toMatchObject({ ok: true, read: { wallet: WALLET, energyLimit: 0, energyUsed: 0 } });
    const g = byUrl({ [ACCOUNT_URL]: account });
    const s = await readAccountResource(WALLET, ctxFor(g.fetchImpl));
    expect(s).toMatchObject({ ok: true, read: { energyLimit: 2_236_000_000, energyUsed: 1_450_000_000, hour: 1, source: ACCOUNT_URL } });
  });
  it("rejects a negative or non-numeric value as a schema error", async () => {
    for (const body of ['{"EnergyLimit":-1}', '{"EnergyUsed":-5}', '{"EnergyLimit":"7"}', '{"EnergyUsed":null}']) {
      const r = await readAccountResource(WALLET, ctxFor(byUrl({ [ACCOUNT_URL]: body }).fetchImpl));
      expect(r).toMatchObject({ ok: false });
      expect(r.ok === false && r.reason).toMatch(/^schema:/);
    }
  });
  it.each([["{}"], ["[]"], ['{"EnergyLimit":5}']])("rejects the body %s as a schema failure", async (body) => {
    const r = await readAccountResource(WALLET, ctxFor(byUrl({ [ACCOUNT_URL]: body }).fetchImpl));
    expect(r.ok === false && r.reason).toMatch(/^schema:/);
  });
  it("reports TronGrid's Error text, whitespace-collapsed and cut to 200 characters", async () => {
    const limited = JSON.stringify({ Error: RATE_LIMIT });
    const a = await readAccountResource(WALLET, ctxFor(byUrl({ [ACCOUNT_URL]: limited }).fetchImpl));
    expect(a).toEqual({ ok: false, reason: `upstream error: ${RATE_LIMIT}` });
    const b = await readAccountResource(WALLET, ctxFor(byUrl({ [ACCOUNT_URL]: JSON.stringify({ Error: "a\n  b\t\tc", TotalEnergyLimit: 1 }) }).fetchImpl));
    expect(b).toEqual({ ok: false, reason: "upstream error: a b c" });
    const c = await readAccountResource(WALLET, ctxFor(byUrl({ [ACCOUNT_URL]: JSON.stringify({ Error: "x".repeat(500) }) }).fetchImpl));
    expect(c).toEqual({ ok: false, reason: `upstream error: ${"x".repeat(200)}` });
  });
  it("scrubs the API key from the Error text before cutting it", async () => {
    const body = JSON.stringify({ Error: `${"x".repeat(195)}${KEY} tail` });
    const r = await readAccountResource(WALLET, ctxFor(byUrl({ [ACCOUNT_URL]: body }).fetchImpl));
    expect(r.ok === false && r.reason).not.toContain("test-key");
    expect(r.ok === false && r.reason).toMatch(/^upstream error: x{195}\[reda$/);
  });
  it("rejects a bad address without calling the network", async () => {
    for (const bad of ["", "T123", "0x" + "a".repeat(40), WALLET + "x", "A" + WALLET.slice(1), WALLET.replace("U", "0")]) {
      const f = byUrl({ [ACCOUNT_URL]: account });
      const r = await readAccountResource(bad, ctxFor(f.fetchImpl));
      expect(r).toEqual({ ok: false, reason: "invalid address" });
      expect(f.fetchImpl).toHaveBeenCalledTimes(0);
    }
  });
  it("fails fast on an empty key without calling the network", async () => {
    const f = byUrl({ [ACCOUNT_URL]: account });
    const r = await readAccountResource(WALLET, { ...ctxFor(f.fetchImpl), apiKey: "" });
    expect(r).toEqual({ ok: false, reason: "API key is empty" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(0);
  });
  it("scrubs the API key from a reason even without a redactor", async () => {
    const fetchImpl = (async () => new Response("denied for key SECRETKEY123 sorry", { status: 403 })) as unknown as typeof fetch;
    const r = await readAccountResource(WALLET, { ...ctxFor(fetchImpl), apiKey: "SECRETKEY123" });
    expect(r.ok === false && r.reason).toMatch(/403/);
    expect(r.ok === false && r.reason).not.toContain("SECRETKEY123");
    expect(r.ok === false && r.reason).toContain("[redacted]");
  });
  it("sends the wallet in the POST body and the key header", async () => {
    const f = byUrl({ [ACCOUNT_URL]: account });
    await readAccountResource(WALLET, ctxFor(f.fetchImpl));
    const init = f.lastInit();
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ address: WALLET, visible: true });
    expect((init?.headers as Record<string, string>)["TRON-PRO-API-KEY"]).toBe(KEY);
  });
  it("returns [redaction failed] when the redactor throws", async () => {
    const r = await readAccountResource(WALLET, { ...ctxFor(byUrl({}).fetchImpl), redact: () => { throw new Error("boom"); } });
    expect(r).toEqual({ ok: false, reason: "[redaction failed]" });
  });
  it("redacts failure reasons when given a redactor", async () => {
    const r = await readAccountResource(WALLET, { ...ctxFor(byUrl({}).fetchImpl), redact: (s) => s.replace("404", "[x]") });
    expect(r.ok === false && r.reason).toMatch(/\[x\]/);
  });
  it("reports a failure with the helper's reason", async () => {
    const r = await readAccountResource(WALLET, ctxFor(byUrl({}).fetchImpl));
    expect(r.ok === false && r.reason).toMatch(/404/);
  });
});

describe("readAccountEnergyStake", () => {
  const getaccount = readFileSync(new URL("../fixtures/trongrid-getaccount-strx.json", import.meta.url), "utf8");
  const STRX = "TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5";
  const URL_GA = "https://api.trongrid.io/wallet/getaccount";
  it("adds the frozenV2 ENERGY entry and the energy delegated out, on the recorded sTRX answer", async () => {
    const r = await readAccountEnergyStake(STRX, ctxFor(byUrl({ [URL_GA]: getaccount }).fetchImpl));
    // 3,390,507,802,431,338 frozen + 1,609,492,197,568,662 delegated; the bandwidth entry (no type) and TRON_POWER are not counted
    expect(r).toEqual({ ok: true, wallet: STRX, energyStakeSun: 5_000_000_000_000_000, delegatedOutSun: 1_609_492_197_568_662, source: URL_GA });
  });
  it("adds the Stake 1.0 energy fields when present (a constructed answer: the recorded one has none)", async () => {
    const stake1 = readFileSync(new URL("../fixtures/trongrid-getaccount-stake1-constructed.json", import.meta.url), "utf8");
    const W = "TStake1ExampLeAccount1111111111111";
    const r = await readAccountEnergyStake(W, ctxFor(byUrl({ [URL_GA]: stake1 }).fetchImpl));
    // frozenV2 ENERGY 20,000,000 + delegated V2 50,000,000 + Stake 1.0 frozen 300,000,000 + Stake 1.0 delegated 4,000,000,000
    expect(r).toMatchObject({ ok: true, energyStakeSun: 4_370_000_000 });
    // delegated out: Stake 2.0 50,000,000 + Stake 1.0 4,000,000,000
    expect(r).toMatchObject({ delegatedOutSun: 4_050_000_000 });
    const bad = await readAccountEnergyStake(W, ctxFor(byUrl({ [URL_GA]: JSON.stringify({ address: W, account_resource: { frozen_balance_for_energy: 5 } }) }).fetchImpl));
    expect(bad).toEqual({ ok: false, reason: "schema: frozen_balance_for_energy is not an object" });
  });
  it("posts the address with visible:true and the key", async () => {
    const f = byUrl({ [URL_GA]: getaccount });
    await readAccountEnergyStake(STRX, ctxFor(f.fetchImpl));
    expect(JSON.parse(String(f.lastInit()?.body))).toEqual({ address: STRX, visible: true });
    expect((f.lastInit()?.headers as Record<string, string>)["TRON-PRO-API-KEY"]).toBe(KEY);
  });
  it("treats absent fields as zero and fails an unknown account ({}), an Error body, a bad amount and an empty key", async () => {
    const ok = await readAccountEnergyStake(STRX, ctxFor(byUrl({ [URL_GA]: JSON.stringify({ address: STRX }) }).fetchImpl));
    expect(ok).toMatchObject({ ok: true, energyStakeSun: 0, delegatedOutSun: 0 });
    const unknown = await readAccountEnergyStake(STRX, ctxFor(byUrl({ [URL_GA]: "{}" }).fetchImpl));
    expect(unknown).toEqual({ ok: false, reason: "schema: address missing or not the one asked for" });
    const limited = await readAccountEnergyStake(STRX, ctxFor(byUrl({ [URL_GA]: JSON.stringify({ Error: RATE_LIMIT }) }).fetchImpl));
    expect(limited).toMatchObject({ ok: false, reason: expect.stringContaining("request rate exceeded") });
    const bad = await readAccountEnergyStake(STRX, ctxFor(byUrl({ [URL_GA]: JSON.stringify({ address: STRX, frozenV2: [{ type: "ENERGY", amount: -1 }] }) }).fetchImpl));
    expect(bad).toEqual({ ok: false, reason: "schema: frozenV2 ENERGY amount is negative" });
    const noKey = await readAccountEnergyStake(STRX, { ...ctxFor(byUrl({}).fetchImpl), apiKey: "" });
    expect(noKey).toEqual({ ok: false, reason: "API key is empty" });
  });
});
