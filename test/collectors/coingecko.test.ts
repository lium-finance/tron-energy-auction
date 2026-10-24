import { describe, expect, it } from "vitest";
import { readTrxUsd } from "../../src/collectors/coingecko.js";

const f = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as unknown as typeof fetch;
const read = (body: string) => readTrxUsd({ budgetMs: 1000, retryAtMs: 500, fetchImpl: f(body) });

describe("readTrxUsd", () => {
  it("returns the price", async () => {
    expect(await readTrxUsd({ budgetMs: 1000, retryAtMs: 500, fetchImpl: f('{"tron":{"usd":0.330411}}') })).toEqual({ ok: true, trxUsd: 0.330411 });
  });
  it("returns a failure on 429 twice or a missing field", async () => {
    expect((await readTrxUsd({ budgetMs: 200, retryAtMs: 100, backoffMs: 10, fetchImpl: f("slow", 429) })).ok).toBe(false);
    expect(await readTrxUsd({ budgetMs: 1000, retryAtMs: 500, fetchImpl: f('{"tron":{}}') })).toEqual({ ok: false, reason: "schema: tron.usd missing or not a number" });
  });
  it("fails a 429 for the right reason: it retried once and was refused twice", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response("slow", { status: 429 });
    }) as unknown as typeof fetch;
    const r = await readTrxUsd({ budgetMs: 200, retryAtMs: 100, backoffMs: 10, fetchImpl: counting });
    expect(r).toEqual({ ok: false, reason: "rate-limited: 429 twice" });
    expect(calls).toBe(2);
  });
  it.each([["zero", '{"tron":{"usd":0}}'], ["negative", '{"tron":{"usd":-0.33}}'], ["a string", '{"tron":{"usd":"0.33"}}'], ["null", '{"tron":{"usd":null}}']])(
    "rejects a price that is %s",
    async (_name, body) => {
      const r = await read(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^schema: tron\.usd /);
    },
  );
  it("returns a failure, not a throw, on a body that is JSON-shaped but broken", async () => {
    const r = await read('{"tron":');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/^schema: /);
  });
  it("returns a failure on a body that is an array or has no tron key", async () => {
    expect((await read("[]")).ok).toBe(false);
    expect((await read("{}")).ok).toBe(false);
  });
});
