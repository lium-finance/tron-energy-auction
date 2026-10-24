import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainContext, ResourceResult } from "../../src/collectors/chain.js";
import type { ResourceRead } from "../../src/core/types.js";
import { PACED_FETCH_OPTIONS } from "../../src/collectors/pace.js";
import { tronAddressHex } from "../../src/core/address.js";
import { loadWallets, parseWallets, type Wallets } from "../../src/index/wallet-list.js";
import { readWallets } from "../../src/index/wallets.js";

/** Synthetic addresses with a valid base58check checksum (0x41 + 20 bytes); none is a real wallet or contract. */
const A = "TExampLeSupp1ierWa11etAAAAAAE5MwZh";
const B = "TExampLeTopStakerWa11etBBBBBDJGqNw";
const C = "TExampLeTopStakerWa11etCCCCCBvCnqf";

const doc = (over: { supplier?: unknown; top100?: Record<string, unknown> } = {}): string =>
  JSON.stringify({
    supplier: over.supplier ?? [A],
    top100: { source: "s", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.4, wallets: [B], ...over.top100 },
  });

describe("parseWallets", () => {
  it("accepts the documented shape and rejects a malformed address", () => {
    const ok = parseWallets('{"supplier":["TExampLeSupp1ierWa11etAAAAAAE5MwZh"],"top100":{"source":"s","readAt":"2026-10-28T09:00:00Z","shareOfTotalEnergyWeight":0.4,"wallets":["TExampLeTopStakerWa11etBBBBBDJGqNw"]}}');
    expect(ok.supplier).toHaveLength(1);
    expect(() => parseWallets('{"supplier":["not-an-address"],"top100":{"source":"s","readAt":"x","shareOfTotalEnergyWeight":0,"wallets":[]}}')).toThrow("supplier[0] is not a Tron address");
  });
  it("returns only the documented fields", () => {
    expect(parseWallets(doc({ top100: { extra: 1 } }))).toEqual({ supplier: [A], top100: { source: "s", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.4, wallets: [B], stakeTotals: null } });
  });
  it("rejects addresses outside the base58 alphabet, of the wrong length or not strings", () => {
    expect(() => parseWallets(doc({ top100: { wallets: [B, "T0" + "1".repeat(32)] } }))).toThrow("top100.wallets[1] is not a Tron address");
    expect(() => parseWallets(doc({ supplier: [A.slice(0, 33)] }))).toThrow("supplier[0] is not a Tron address");
    expect(() => parseWallets(doc({ supplier: [42] }))).toThrow("supplier[0] is not a Tron address");
    expect(() => parseWallets(doc({ supplier: A.slice(0, 6) }))).toThrow("supplier must be an array");
  });
  it("rejects a duplicate within a list, and allows a wallet in both lists", () => {
    expect(() => parseWallets(doc({ supplier: [A, A] }))).toThrow("supplier[1] repeats supplier[0]");
    expect(() => parseWallets(doc({ top100: { wallets: [B, C, B] } }))).toThrow("top100.wallets[2] repeats top100.wallets[0]");
    expect(parseWallets(doc({ top100: { wallets: [C, A] } }))).toMatchObject({ supplier: [A], top100: { wallets: [C, A] } });
  });
  it("needs a supplier wallet and 1 to 150 top-100 wallets", () => {
    expect(() => parseWallets(doc({ supplier: [] }))).toThrow("supplier must list at least one wallet");
    expect(() => parseWallets(doc({ top100: { wallets: [] } }))).toThrow("top100.wallets must list 1 to 150 wallets");
    // 151 distinct valid-shape addresses
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const many = Array.from({ length: 151 }, (_, i) => `T${B58[Math.floor(i / 58)]}${B58[i % 58]}${"a".repeat(31)}`);
    expect(new Set(many).size).toBe(151);
    expect(() => parseWallets(doc({ top100: { wallets: many } }))).toThrow("top100.wallets must list 1 to 150 wallets");
    expect(parseWallets(doc({ top100: { wallets: many.slice(0, 150) } })).top100.wallets).toHaveLength(150);
  });
  it("checks readAt, the share and the source", () => {
    for (const bad of ["x", "2026-10-28", "2026-13-28T09:00:00Z", "2026-10-28 09:00:00", 1792684434000]) {
      expect(() => parseWallets(doc({ top100: { readAt: bad } }))).toThrow("top100.readAt must be an ISO timestamp");
    }
    expect(parseWallets(doc({ top100: { readAt: "2026-10-28T09:00:00.123+08:00" } })).top100.readAt).toBe("2026-10-28T09:00:00.123+08:00");
    for (const bad of [-0.01, 1.01, "0.4", null, Number.NaN]) {
      expect(() => parseWallets(doc({ top100: { shareOfTotalEnergyWeight: bad } }))).toThrow("top100.shareOfTotalEnergyWeight must be a number from 0 to 1");
    }
    expect(parseWallets(doc({ top100: { shareOfTotalEnergyWeight: 1 } })).top100.shareOfTotalEnergyWeight).toBe(1);
    expect(() => parseWallets(doc({ top100: { source: " " } }))).toThrow("top100.source must name");
  });
  it("rejects text that is not JSON or not an object, as a ConfigError, without echoing it", () => {
    expect(() => parseWallets("{ supplier: TExampLeSupp1ierWa11etAAAAAAE5MwZh")).toThrow(expect.objectContaining({ name: "ConfigError", message: "the wallets file is not valid JSON" }));
    expect(() => parseWallets("[]")).toThrow("the wallets file must be a JSON object");
    expect(() => parseWallets(JSON.stringify({ supplier: [A] }))).toThrow("top100 must be an object");
  });
  it("accepts top100 wallets as objects with optional stake numbers, and totals them only when every entry has both", () => {
    const objects = parseWallets(doc({ top100: { wallets: [{ address: B, energyStakeTrx: 100, delegatedOutTrx: 40 }, { address: C, energyStakeTrx: 50.5, delegatedOutTrx: 0 }] } }));
    expect(objects.top100.wallets).toEqual([B, C]);
    expect(objects.top100.stakeTotals).toEqual({ energyStakeTrx: 150.5, delegatedOutTrx: 40 });
    const mixed = parseWallets(doc({ top100: { wallets: [{ address: B, energyStakeTrx: 100, delegatedOutTrx: 40 }, C] } }));
    expect(mixed.top100).toMatchObject({ wallets: [B, C], stakeTotals: null });
    const partial = parseWallets(doc({ top100: { wallets: [{ address: B, energyStakeTrx: 100 }] } }));
    expect(partial.top100).toMatchObject({ wallets: [B], stakeTotals: null });
    expect(parseWallets(doc()).top100.stakeTotals).toBeNull();
  });
  it("checks an object entry's address like a plain one, and its numbers when present", () => {
    expect(() => parseWallets(doc({ top100: { wallets: [{ address: "nope" }] } }))).toThrow("top100.wallets[0] is not a Tron address");
    expect(() => parseWallets(doc({ top100: { wallets: [{ energyStakeTrx: 1 }] } }))).toThrow("top100.wallets[0] is not a Tron address");
    expect(() => parseWallets(doc({ top100: { wallets: [B, { address: B }] } }))).toThrow("top100.wallets[1] repeats top100.wallets[0]");
    for (const bad of [-1, Number.NaN, "5", null]) {
      expect(() => parseWallets(doc({ top100: { wallets: [{ address: B, energyStakeTrx: bad, delegatedOutTrx: 0 }] } }))).toThrow("top100.wallets[0].energyStakeTrx must be a number of at least 0");
      expect(() => parseWallets(doc({ top100: { wallets: [{ address: B, energyStakeTrx: 1, delegatedOutTrx: bad }] } }))).toThrow("top100.wallets[0].delegatedOutTrx must be a number of at least 0");
    }
    // the supplier list stays plain addresses
    expect(() => parseWallets(doc({ supplier: [{ address: A }] }))).toThrow("supplier[0] is not a Tron address");
  });
  it("reads object entries from a top100File too", () => {
    const dir = mkdtempSync(join(tmpdir(), "wallets-"));
    writeFileSync(join(dir, "top.json"), JSON.stringify({ source: "s", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.4, energyStakeTrx: 10, delegatedOutTrx: 5, delegatedOutShare: 0.5, wallets: [{ address: B, energyStakeTrx: 10, delegatedOutTrx: 5 }] }));
    writeFileSync(join(dir, "w.json"), JSON.stringify({ supplier: [A], top100File: "top.json" }));
    expect(loadWallets(join(dir, "w.json")).top100).toMatchObject({ wallets: [B], stakeTotals: { energyStakeTrx: 10, delegatedOutTrx: 5 } });
    writeFileSync(join(dir, "top.json"), JSON.stringify({ source: "s", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.4, wallets: [{ address: B, energyStakeTrx: -2, delegatedOutTrx: 5 }] }));
    expect(() => loadWallets(join(dir, "w.json"))).toThrow("top100.wallets[0].energyStakeTrx must be a number of at least 0 (in top100File top.json)");
  });
  it("loads the committed example file, and reports an unreadable file as a ConfigError", () => {
    const path = fileURLToPath(new URL("../../docs/verification/wallets.example.json", import.meta.url));
    const w = loadWallets(path);
    expect(w.supplier).toHaveLength(2);
    expect(w.top100.wallets).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toContain("Examp");
    expect(() => loadWallets("/nonexistent/wallets.json")).toThrow(expect.objectContaining({ name: "ConfigError" }));
  });
});

describe("top100File", () => {
  const section = { source: "s", readAt: "2026-10-28T09:00:00Z", k: 300, exact: true, shareOfTotalEnergyWeight: 0.4, wallets: [B, C] };
  function files(walletsDoc: unknown, top: unknown, name = "top100-2026-10-28.json") {
    const dir = mkdtempSync(join(tmpdir(), "wallets-"));
    mkdirSync(join(dir, "verification"));
    writeFileSync(join(dir, "verification", name), typeof top === "string" ? top : JSON.stringify(top));
    writeFileSync(join(dir, "verification", "wallets.json"), JSON.stringify(walletsDoc));
    return join(dir, "verification", "wallets.json");
  }

  it("reads the top100 section from the named file, relative to the wallets file, dropping the builder's extra fields", () => {
    const w = loadWallets(files({ supplier: [A], top100File: "top100-2026-10-28.json" }, section));
    expect(w).toEqual({ supplier: [A], top100: { source: "s", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.4, wallets: [B, C], stakeTotals: null } });
  });
  it("gives the same answer as the inline form", () => {
    const inline = parseWallets(JSON.stringify({ supplier: [A], top100: section }));
    expect(loadWallets(files({ supplier: [A], top100File: "top100-2026-10-28.json" }, section))).toEqual(inline);
  });
  it("applies the same rules to the referenced file and says the error came from it", () => {
    expect(() => loadWallets(files({ supplier: [A], top100File: "t.json" }, { ...section, wallets: [B, C, B] }, "t.json"))).toThrow("top100.wallets[2] repeats top100.wallets[0] (in top100File t.json)");
    expect(loadWallets(files({ supplier: [A], top100File: "t.json" }, { ...section, wallets: [B, A] }, "t.json")).top100.wallets).toEqual([B, A]);
    expect(() => loadWallets(files({ supplier: [A], top100File: "t.json" }, { ...section, readAt: "yesterday" }, "t.json"))).toThrow("top100.readAt must be an ISO timestamp (in top100File t.json)");
    expect(() => loadWallets(files({ supplier: [A], top100File: "t.json" }, { ...section, wallets: [] }, "t.json"))).toThrow("top100.wallets must list 1 to 150 wallets (in top100File t.json)");
    expect(() => loadWallets(files({ supplier: [A], top100File: "t.json" }, "not json", "t.json"))).toThrow("top100File is not valid JSON (in top100File t.json)");
  });
  it("rejects both forms at once, a missing or unreadable file, and top100File without a reader", () => {
    expect(() => loadWallets(files({ supplier: [A], top100: section, top100File: "t.json" }, section, "t.json"))).toThrow("give either top100 or top100File, not both");
    expect(() => loadWallets(files({ supplier: [A], top100File: "missing.json" }, section, "t.json"))).toThrow(expect.objectContaining({ name: "ConfigError", message: expect.stringContaining("top100File cannot be read") }));
    expect(() => loadWallets(files({ supplier: [A], top100File: " " }, section, "t.json"))).toThrow("top100File must be a path");
    expect(() => parseWallets(JSON.stringify({ supplier: [A], top100File: "t.json" }))).toThrow("top100File can only be read through loadWallets");
  });
});

describe("readWallets", () => {
  const HOUR = 500_000;
  const hourMs = HOUR * 3_600_000;
  const ctx: ChainContext = { hour: HOUR, now: new Date(hourMs), apiKey: "k", fetchOptions: { budgetMs: 1000, retryAtMs: 500 } };
  const wallets = (supplier: string[], top: string[]): Wallets => ({ supplier, top100: { source: "s", readAt: "2026-10-28T09:00:00Z", shareOfTotalEnergyWeight: 0.1, wallets: top, stakeTotals: null } });
  const addr = (i: number): string => `T${"abcdefghij"[i]}${"2".repeat(32)}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(hourMs + 3_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake reader that records when each call started; `answer` decides the result per call. */
  function fakeRead(answer: (wallet: string, call: number) => ResourceResult = (wallet) => ({ ok: true, read: { hour: HOUR, wallet, energyLimit: 1, energyUsed: 0, readAt: new Date(), source: "x" } })) {
    const calls: { wallet: string; at: number; ctx: ChainContext }[] = [];
    const read = vi.fn(async (wallet: string, c: ChainContext): Promise<ResourceResult> => {
      calls.push({ wallet, at: Date.now(), ctx: c });
      return answer(wallet, calls.length);
    });
    return { read, calls };
  }

  async function run(w: Wallets, o: Parameters<typeof readWallets>[4], lines: string[] = []) {
    const inserted: ResourceRead[] = [];
    const p = readWallets({} as never, w, ctx, (l) => lines.push(l), { insert: async (_sql, r) => { inserted.push(r); }, ...o });
    await vi.runAllTimersAsync();
    return { result: await p, inserted, lines };
  }

  it("paces 5 wallets at 2 requests a second: they take at least 2 s, sequential, in list order, supplier first", async () => {
    const { read, calls } = fakeRead();
    const start = Date.now();
    const { result, inserted } = await run(wallets([addr(0), addr(1)], [addr(2), addr(3), addr(4)]), { rps: 2, read });
    expect(result).toEqual({ read: 5, failed: 0 });
    expect(calls.map((c) => c.wallet)).toEqual([0, 1, 2, 3, 4].map(addr));
    expect(calls.map((c) => c.at - start)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(calls[4]!.at - start).toBeGreaterThanOrEqual(2000);
    expect(inserted.map((r) => r.wallet)).toEqual([0, 1, 2, 3, 4].map(addr));
    // each read is stamped with the hour and the moment it was taken
    expect(calls.every((c) => c.ctx.hour === HOUR)).toBe(true);
    expect(calls.map((c) => c.ctx.now.getTime())).toEqual(calls.map((c) => c.at));
  });

  it("defaults to 2 requests a second and honours a higher rate", async () => {
    const a = fakeRead();
    const start = Date.now();
    await run(wallets([addr(0)], [addr(1), addr(2)]), { read: a.read });
    expect(a.calls.map((c) => c.at - start)).toEqual([0, 500, 1000]);
    const b = fakeRead();
    const start2 = Date.now();
    await run(wallets([addr(0)], [addr(1), addr(2)]), { rps: 10, read: b.read });
    expect(b.calls.map((c) => c.at - start2)).toEqual([0, 100, 200]);
  });

  it("retries a rate-limited answer once after 2 s, then moves on", async () => {
    const rateLimited: ResourceResult = { ok: false, reason: "upstream error: request rate exceeded the allowed_rps(3), and the query server is suspended for 1s" };
    const { read, calls } = fakeRead((wallet, call) => (call === 2 ? rateLimited : { ok: true, read: { hour: HOUR, wallet, energyLimit: 1, energyUsed: 0, readAt: new Date(), source: "x" } }));
    const start = Date.now();
    const { result, lines } = await run(wallets([addr(0), addr(1)], [addr(2)]), { rps: 2, read });
    expect(result).toEqual({ read: 3, failed: 0 });
    expect(calls.map((c) => [c.wallet, c.at - start])).toEqual([[addr(0), 0], [addr(1), 500], [addr(1), 2500], [addr(2), 3000]]);
    expect(lines).toEqual(["verification supplier[1]: rate limited; retrying once in 2 s"]);
  });

  it("retries only once: a wallet rate-limited twice is logged and counted as failed; a 429 counts as rate-limited", async () => {
    const { read, calls } = fakeRead((wallet) => (wallet === addr(0) ? { ok: false, reason: "rate-limited: HTTP 429" } : { ok: true, read: { hour: HOUR, wallet, energyLimit: 1, energyUsed: 0, readAt: new Date(), source: "x" } }));
    const { result, lines, inserted } = await run(wallets([addr(0)], [addr(1)]), { read });
    expect(result).toEqual({ read: 1, failed: 1 });
    expect(calls.map((c) => c.wallet)).toEqual([addr(0), addr(0), addr(1)]);
    expect(inserted.map((r) => r.wallet)).toEqual([addr(1)]);
    expect(lines).toEqual(["verification supplier[0]: rate limited; retrying once in 2 s", "verification supplier[0]: rate-limited: HTTP 429"]);
  });

  it("logs any other failure with the wallet shortened, does not retry it, and carries on", async () => {
    const { read, calls } = fakeRead((wallet) => (wallet === addr(1) ? { ok: false, reason: "timeout: no answer in 20000 ms" } : { ok: true, read: { hour: HOUR, wallet, energyLimit: 1, energyUsed: 0, readAt: new Date(), source: "x" } }));
    const { result, lines } = await run(wallets([addr(0), addr(1)], [addr(2)]), { read });
    expect(result).toEqual({ read: 2, failed: 1 });
    expect(calls).toHaveLength(3);
    expect(lines).toEqual(["verification supplier[1]: timeout: no answer in 20000 ms"]);
    expect(lines.join("\n")).not.toContain(addr(1));
  });

  it("reads a wallet in both lists once, under its supplier label; top-100-only wallets use their own index", async () => {
    const { read, calls } = fakeRead((wallet) => (wallet === addr(3) ? { ok: false, reason: "timeout: no answer" } : { ok: true, read: { hour: HOUR, wallet, energyLimit: 1, energyUsed: 0, readAt: new Date(), source: "x" } }));
    const { result, lines } = await run(wallets([addr(0), addr(1)], [addr(2), addr(1), addr(3)]), { read });
    expect(calls.map((c) => c.wallet)).toEqual([addr(0), addr(1), addr(2), addr(3)]);
    expect(result).toEqual({ read: 3, failed: 1 });
    // top100[2] is addr(3)'s index in its own list, never its position in the union (3)
    expect(lines).toEqual(["verification top100[2]: timeout: no answer"]);
  });

  it("never logs a full address: the wallet in an upstream reason is replaced by its label", async () => {
    const { read } = fakeRead((wallet) => ({ ok: false, reason: `upstream error: account ${wallet} not found; ${wallet}` }));
    const { lines } = await run(wallets([addr(0)], [addr(1)]), { read });
    expect(lines).toEqual(["verification supplier[0]: upstream error: account supplier[0] not found; supplier[0]", "verification top100[0]: upstream error: account top100[0] not found; top100[0]"]);
    expect(lines.join("\n")).not.toMatch(/T[1-9A-HJ-NP-Za-km-z]{33}/);
  });

  it("also replaces the hex form of the wallet (41 + 40 hex, any case, with or without 0x) in an upstream reason", async () => {
    expect(tronAddressHex(A)).toBe("4136ba63159ace1bcfdb2f129d5b604959260aeb1e");
    const forms = (hex: string): string[] => [hex, hex.toUpperCase(), `0x${hex}`, `0X${hex.toUpperCase()}`, `0x${hex.slice(2)}`, hex.slice(2).toUpperCase()];
    const { read } = fakeRead((wallet) => ({ ok: false, reason: `upstream error: ${forms(tronAddressHex(wallet)!).join(" / ")}` }));
    const { lines } = await run(wallets([A], [B]), { read });
    expect(lines).toEqual([
      `verification supplier[0]: upstream error: ${Array(6).fill("supplier[0]").join(" / ")}`,
      `verification top100[0]: upstream error: ${Array(6).fill("top100[0]").join(" / ")}`,
    ]);
    for (const w of [A, B]) expect(lines.join("\n").toLowerCase()).not.toContain(tronAddressHex(w)!.slice(2));
  });

  it("with PACED_FETCH_OPTIONS a 429 is not retried inside fetchQuote: exactly 2 fetches per wallet, the pacer's retry", async () => {
    const fetches: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetches.push(JSON.parse(String(init?.body)).address as string);
      return new Response("too many", { status: 429 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const p = readWallets({} as never, wallets([addr(0)], [addr(1)]), { ...ctx, fetchOptions: { ...PACED_FETCH_OPTIONS, fetchImpl } }, (l) => lines.push(l), { insert: async () => {} });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ read: 0, failed: 2 });
    expect(fetches).toEqual([addr(0), addr(0), addr(1), addr(1)]);
    expect(lines.filter((l) => l.includes("rate limited; retrying once"))).toHaveLength(2);
  });

  it("rejects when an insert fails (the database, not the wallet, is the problem)", async () => {
    const { read } = fakeRead();
    const p = readWallets({} as never, wallets([addr(0)], [addr(1)]), ctx, () => {}, { read, insert: async () => { throw new Error("connection refused"); } });
    const settled = p.then(() => "resolved", (e: Error) => e.message);
    await vi.runAllTimersAsync();
    expect(await settled).toBe("connection refused");
  });

  it("stops starting reads 20 minutes into the hour, counting the rest as failed and saying so", async () => {
    vi.setSystemTime(hourMs + 20 * 60_000 - 600);
    const { read, calls } = fakeRead();
    const { result, lines } = await run(wallets([addr(0), addr(1)], [addr(2), addr(3)]), { read });
    expect(calls.map((c) => c.wallet)).toEqual([addr(0), addr(1)]);
    expect(result).toEqual({ read: 2, failed: 2 });
    expect(lines).toEqual([`verification: 2 of 4 wallets not read: past ${new Date(hourMs + 20 * 60_000).toISOString()}`]);
  });

  it("reads nothing when it starts more than 20 minutes into its hour", async () => {
    vi.setSystemTime(hourMs + 50 * 60_000);
    const { read } = fakeRead();
    const { result } = await run(wallets([addr(0)], [addr(1)]), { read });
    expect(read).not.toHaveBeenCalled();
    expect(result).toEqual({ read: 0, failed: 2 });
  });

  it("stops after a 10-minute budget even early in the hour (a hanging TronGrid)", async () => {
    const read = vi.fn(async (wallet: string): Promise<ResourceResult> => {
      await new Promise((r) => setTimeout(r, 4 * 60_000));
      return { ok: false, reason: `timeout ${wallet.length}` };
    });
    const { result } = await run(wallets([addr(0), addr(1)], [addr(2), addr(3)]), { read });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ read: 0, failed: 4 });
  });
});
