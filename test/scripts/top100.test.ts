import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainResult, EnergyStakeResult } from "../../src/collectors/chain.js";
import { parseWallets } from "../../src/index/wallet-list.js";
import { buildTop100, parseBuildArgs, parseRankingPage, rankingUrl, selectTop, shareOfTotalEnergyWeight, type Staked } from "../../src/scripts/top100.js";

const page50 = readFileSync(new URL("../fixtures/tronscan-account-list-power-50.json", import.meta.url), "utf8");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A distinct valid-shape address per index. */
const addr = (i: number): string => `T${B58[Math.floor(i / 58) % 58]}${B58[i % 58]}${"x".repeat(31)}`;
const TRX = 1_000_000;

describe("parseRankingPage", () => {
  it("reads address and power from the recorded 50-row page, in descending power", () => {
    const rows = parseRankingPage(page50);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual({ address: "TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5", powerSun: 9_835_024_853_068_643 });
    expect(rows.every((r, i) => i === 0 || r.powerSun <= rows[i - 1]!.powerSun)).toBe(true);
    expect(Object.keys(rows[1]!)).toEqual(["address", "powerSun"]);
  });
  it("throws on a missing data array, a bad address or a bad power", () => {
    expect(() => parseRankingPage('{"message":"some parameters are invalid or out of range"}')).toThrow("ranking page has no data array");
    expect(() => parseRankingPage('{"data":[{"address":"x","power":1}]}')).toThrow("data[0].address is not a Tron address");
    expect(() => parseRankingPage(`{"data":[{"address":"${addr(1)}","power":"1"}]}`)).toThrow("data[0].power is not a number");
  });
});

describe("selectTop", () => {
  /** 120 accounts by descending power; account i stakes `stake(i)` for energy. */
  const accounts = (n: number, power: (i: number) => number, stake: (i: number) => number): Staked[] =>
    Array.from({ length: n }, (_, i) => ({ address: addr(i), powerSun: power(i), energyStakeSun: stake(i) }));

  it("ranks by energy stake, not by total stake, and leaves out accounts with none", () => {
    const a = accounts(120, (i) => (1000 - i) * TRX, (i) => (i % 2 === 0 ? (500 + i) * TRX : 0));
    const { top } = selectTop(a, 3);
    expect(top.map((x) => x.address)).toEqual([addr(118), addr(116), addr(114)]);
    expect(selectTop(a).top).toHaveLength(60);
  });
  it("is exact only when the 100th energy stake is at least the K-th account's total stake", () => {
    const power = (i: number) => (10_000 - i) * TRX; // the K-th (120th) account has 9,881 TRX
    expect(selectTop(accounts(120, power, () => 9_881 * TRX)).exact).toBe(true);
    const r = selectTop(accounts(120, power, (i) => (i < 99 ? 9_900 * TRX : 9_880 * TRX)));
    expect(r).toMatchObject({ exact: false, kthPowerSun: 9_881 * TRX, nthStakeSun: 9_880 * TRX });
  });
  it("is never exact with fewer than 100 stakers, or when a stake exceeds its account's total stake", () => {
    expect(selectTop(accounts(99, () => 5 * TRX, () => 5 * TRX)).exact).toBe(false);
    const a = accounts(120, () => 5 * TRX, () => 5 * TRX);
    a[7]!.energyStakeSun = 6 * TRX;
    expect(selectTop(a).exact).toBe(false);
  });
});

describe("shareOfTotalEnergyWeight", () => {
  it("is the stakes in TRX over TotalEnergyWeight in TRX, to 6 decimals", () => {
    // sTRX's recorded 5,000,000,000 TRX energy stake over the recorded 18,538,236,074 TRX weight
    expect(shareOfTotalEnergyWeight([{ address: addr(0), powerSun: 0, energyStakeSun: 5_000_000_000 * TRX }], 18_538_236_074)).toBe(0.269713);
  });
  it("throws on a weight that is not positive or a share above 1", () => {
    expect(() => shareOfTotalEnergyWeight([], 0)).toThrow("TotalEnergyWeight is not positive");
    expect(() => shareOfTotalEnergyWeight([{ address: addr(0), powerSun: 0, energyStakeSun: 11 * TRX }], 10)).toThrow("more than TotalEnergyWeight");
  });
});

describe("parseBuildArgs", () => {
  it("needs an output path; --k defaults to 300 and must be 1 to 10000", () => {
    expect(parseBuildArgs(["/tmp/top.json"])).toEqual({ out: "/tmp/top.json", k: 300 });
    expect(parseBuildArgs(["--k", "5", "/tmp/top.json"])).toEqual({ out: "/tmp/top.json", k: 5 });
    expect(() => parseBuildArgs([])).toThrow("usage: build-top100 <out.json> [--k N]");
    for (const bad of [["--k"], ["--k", "0", "o"], ["--k", "10001", "o"], ["--k", "2.5", "o"]]) expect(() => parseBuildArgs(bad)).toThrow(expect.objectContaining({ name: "ConfigError" }));
    expect(() => parseBuildArgs(["a", "b"])).toThrow("give one output path");
    expect(() => parseBuildArgs(["--out", "a"])).toThrow("unknown option --out");
  });
});

describe("buildTop100", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T09:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const WEIGHT_TRX = 1_000_000;
  /** A ranking of `n` accounts, power 10,000 TRX down; each stakes `stake(i)` for energy. */
  function fakes(n: number, stake: (i: number) => number, o: { rateLimitOnce?: number; failAt?: number } = {}) {
    const pages: { url: string; at: number }[] = [];
    const stakes: { address: string; at: number }[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      pages.push({ url, at: Date.now() });
      const u = new URL(url);
      const start = Number(u.searchParams.get("start"));
      const limit = Number(u.searchParams.get("limit"));
      const data = Array.from({ length: Math.max(0, Math.min(limit, n - start)) }, (_, j) => ({ address: addr(start + j), power: (10_000 - start - j) * TRX, balance: 1 }));
      return { ok: true as const, body: JSON.stringify({ total: n, data }) };
    });
    let limited = false;
    const readStake = vi.fn(async (address: string): Promise<EnergyStakeResult> => {
      stakes.push({ address, at: Date.now() });
      const i = Number(B58.indexOf(address[1]!) * 58 + B58.indexOf(address[2]!));
      if (i === o.rateLimitOnce && !limited) {
        limited = true;
        return { ok: false, reason: "upstream error: request rate exceeded the allowed_rps(3)" };
      }
      if (i === o.failAt) return { ok: false, reason: "timeout: no answer" };
      // a quarter of each stake is delegated out
      return { ok: true, wallet: address, energyStakeSun: stake(i), delegatedOutSun: stake(i) / 4, source: "fake" };
    });
    const readWeight = vi.fn(async (now: Date): Promise<ChainResult> => ({ ok: true, params: { hour: 1, energyFeeSun: 100, totalEnergyLimit: 1, totalEnergyWeightTrx: WEIGHT_TRX, trxUsd: null, readAt: now } }));
    return { fetchPage, readStake, readWeight, pages, stakes };
  }

  async function settle<T>(p: Promise<T>): Promise<T> {
    const out = p.then((v) => ({ v }), (e: unknown) => ({ e }));
    await vi.runAllTimersAsync();
    const r = await out;
    if ("e" in r) throw r.e;
    return r.v;
  }

  it("pages the ranking 2 s apart, paces getaccount at 2 a second, and builds an exact list with its share", async () => {
    const f = fakes(130, (i) => (i < 110 ? 9_890 * TRX : 100 * TRX));
    const lines: string[] = [];
    const t0 = Date.now();
    const s = await settle(buildTop100({ k: 120, fetchPage: f.fetchPage, readStake: f.readStake, readWeight: f.readWeight, log: (l) => lines.push(l) }));
    expect(f.pages.map((p) => [p.url, p.at - t0])).toEqual([
      [rankingUrl(0, 50), 0],
      [rankingUrl(50, 50), 2000],
      [rankingUrl(100, 20), 4000],
    ]);
    expect(f.stakes).toHaveLength(120);
    const gaps = f.stakes.slice(1).map((x, i) => x.at - f.stakes[i]!.at);
    expect(gaps.every((g) => g === 500)).toBe(true);
    expect(f.readWeight).toHaveBeenCalledTimes(1);
    expect(s).toEqual({
      source: expect.stringContaining("sort=-power (top 120 by total stake) + https://api.trongrid.io/wallet/getaccount"),
      readAt: "2026-10-28T09:00:00.000Z",
      k: 120,
      exact: true,
      shareOfTotalEnergyWeight: 0.989, // 100 x 9,890 TRX over 1,000,000 TRX
      energyStakeTrx: 989_000,
      delegatedOutTrx: 247_250,
      delegatedOutShare: 0.25,
      wallets: Array.from({ length: 100 }, (_, i) => ({ address: addr(i), energyStakeTrx: 9_890, delegatedOutTrx: 2_472.5 })),
    });
    expect(lines.some((l) => l.startsWith("top100: exact"))).toBe(true);
    // the section is a valid top100File
    const parsed = parseWallets(JSON.stringify({ supplier: [addr(3000)], top100: s })).top100;
    expect(parsed.wallets).toEqual(Array.from({ length: 100 }, (_, i) => addr(i)));
    expect(parsed.stakeTotals).toEqual({ energyStakeTrx: 989_000, delegatedOutTrx: 247_250 });
    // progress lines name no account by address
    expect(lines.join("\n")).not.toMatch(/T[1-9A-HJ-NP-Za-km-z]{33}/);
  });

  it("says when the list is not exact, and to raise K", async () => {
    const f = fakes(120, () => 50 * TRX);
    const lines: string[] = [];
    const s = await settle(buildTop100({ k: 120, fetchPage: f.fetchPage, readStake: f.readStake, readWeight: f.readWeight, log: (l) => lines.push(l) }));
    expect(s.exact).toBe(false);
    expect(lines.some((l) => l.includes("NOT exact") && l.includes("raise --k"))).toBe(true);
  });

  it("stops paging when the ranking runs out, and honours a higher rps", async () => {
    const f = fakes(60, () => 1 * TRX);
    const s = await settle(buildTop100({ k: 300, rps: 10, fetchPage: f.fetchPage, readStake: f.readStake, readWeight: f.readWeight, log: () => {} }));
    expect(f.pages).toHaveLength(2);
    expect(f.stakes[1]!.at - f.stakes[0]!.at).toBe(100);
    expect(s).toMatchObject({ k: 300, exact: false });
    expect(s.wallets).toHaveLength(60);
  });

  it("retries a rate-limited getaccount once, 2 s later", async () => {
    const f = fakes(5, () => 1 * TRX, { rateLimitOnce: 2 });
    const lines: string[] = [];
    await settle(buildTop100({ k: 5, fetchPage: f.fetchPage, readStake: f.readStake, readWeight: f.readWeight, log: (l) => lines.push(l) }));
    expect(f.stakes.map((x) => x.address)).toEqual([addr(0), addr(1), addr(2), addr(2), addr(3), addr(4)]);
    expect(f.stakes[3]!.at - f.stakes[2]!.at).toBe(2000);
    expect(lines).toContain("top100: getaccount rank 3 rate limited; retrying once");
    expect(lines.join("\n")).not.toContain(addr(2));
  });

  it("retries a rate-limited Tronscan page once, 2 s later, and still builds", async () => {
    const f = fakes(60, () => 1 * TRX);
    let first = true;
    const calls: number[] = [];
    const fetchPage = async (url: string) => {
      calls.push(Date.now());
      if (first) {
        first = false;
        return { ok: false as const, reason: "rate-limited: 429, too little budget left to back off and retry" };
      }
      return f.fetchPage(url);
    };
    const lines: string[] = [];
    const t0 = Date.now();
    const s = await settle(buildTop100({ k: 60, fetchPage, readStake: f.readStake, readWeight: f.readWeight, log: (l) => lines.push(l) }));
    expect(s.wallets).toHaveLength(60);
    // page 1, its retry 2 s later, then page 2 one pacing slot (2 s) after the retry
    expect(calls.map((c) => c - t0)).toEqual([0, 2000, 4000]);
    expect(lines).toContain("top100: Tronscan page start=0 rate limited; retrying once");
  });

  it("fails when a page is rate limited twice, and does not retry other page failures", async () => {
    const g = fakes(5, () => 1 * TRX);
    const limited = vi.fn(async () => ({ ok: false as const, reason: "upstream error: request rate exceeded" }));
    await expect(settle(buildTop100({ k: 5, fetchPage: limited, readStake: g.readStake, readWeight: g.readWeight, log: () => {} }))).rejects.toThrow("Tronscan ranking (start=0) failed: upstream error: request rate exceeded");
    expect(limited).toHaveBeenCalledTimes(2);
    const broken = vi.fn(async () => ({ ok: false as const, reason: "upstream: HTTP 400" }));
    await expect(settle(buildTop100({ k: 5, fetchPage: broken, readStake: g.readStake, readWeight: g.readWeight, log: () => {} }))).rejects.toThrow("upstream: HTTP 400");
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("replaces the address in an upstream reason with the rank", async () => {
    const f = fakes(3, () => 1 * TRX);
    const readStake = async (address: string): Promise<EnergyStakeResult> => ({ ok: false, reason: `upstream error: ${address} unknown` });
    const err = await settle(buildTop100({ k: 3, fetchPage: f.fetchPage, readStake, readWeight: f.readWeight, log: () => {} })).catch((e: Error) => e.message);
    expect(err).toBe("getaccount failed for rank 1: upstream error: rank 1 unknown");
  });

  it("fails on a failed read, a failed page, or a ranking that shifted between pages", async () => {
    const f = fakes(5, () => 1 * TRX, { failAt: 3 });
    await expect(settle(buildTop100({ k: 5, fetchPage: f.fetchPage, readStake: f.readStake, readWeight: f.readWeight, log: () => {} }))).rejects.toThrow("getaccount failed for rank 4: timeout: no answer");
    const g = fakes(5, () => 1 * TRX);
    await expect(settle(buildTop100({ k: 5, fetchPage: async () => ({ ok: false, reason: "upstream: HTTP 400" }), readStake: g.readStake, readWeight: g.readWeight, log: () => {} }))).rejects.toThrow("Tronscan ranking (start=0) failed: upstream: HTTP 400");
    const dup = JSON.stringify({ data: [{ address: addr(0), power: 5 }, { address: addr(0), power: 5 }] });
    await expect(settle(buildTop100({ k: 2, fetchPage: async () => ({ ok: true, body: dup }), readStake: g.readStake, readWeight: g.readWeight, log: () => {} }))).rejects.toThrow("the ranking repeats an account at rank 2");
    const unordered = JSON.stringify({ data: [{ address: addr(0), power: 5 }, { address: addr(1), power: 6 }] });
    await expect(settle(buildTop100({ k: 2, fetchPage: async () => ({ ok: true, body: unordered }), readStake: g.readStake, readWeight: g.readWeight, log: () => {} }))).rejects.toThrow("not in order");
    await expect(settle(buildTop100({ k: 5, fetchPage: g.fetchPage, readStake: g.readStake, readWeight: async () => ({ ok: false, reason: "403" }), log: () => {} }))).rejects.toThrow("reading TotalEnergyWeight failed: 403");
  });
});
