import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectAll, type CollectContext, type VenueAdapter } from "../../src/collectors/adapter.js";
import { MAX_BODY_BYTES } from "../../src/collectors/http.js";
import { redactConfiguredSecrets, redactSecrets } from "../../src/index/redact.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function ctx(fetchImpl: typeof fetch, over: Partial<CollectContext> = {}): CollectContext {
  return {
    hour: 497_870, now: new Date("2026-10-28T14:00:05Z"), energyFeeSun: 100, trxUsd: 0.33,
    fetchOptions: { budgetMs: 1000, retryAtMs: 500, fetchImpl }, redact: (s) => s, env: {}, ...over,
  };
}

const answer = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as unknown as typeof fetch;

const stub = (over: Partial<VenueAdapter> = {}): VenueAdapter => ({
  venue: "stub",
  requests: [{ size: 20_000_000, term: "1h" }, { size: 5_000_000, term: "1h" }],
  request: () => ({ url: "https://stub.test/q", init: {} }),
  parse: () => ({ raw: { kind: "sunPerUnit", value: 40, term: "1h" }, depth: 20_000_000 }),
  ...over,
});

describe("collectAll payloads", () => {
  it("returns the raw body with the hash the quote carries", async () => {
    const body = '{"price":40}';
    const { quotes, payloads } = await collectAll(stub(), ctx(answer(body)));
    expect(quotes).toHaveLength(2);
    expect(quotes.every((q) => q.payloadHash === sha256(body))).toBe(true);
    expect(payloads).toEqual([{ hash: sha256(body), body }, { hash: sha256(body), body }]);
  });

  it("keeps the body of a response that failed to parse: that is the evidence of the drift", async () => {
    const { quotes, payloads } = await collectAll(stub({ requests: [{ size: 20_000_000, term: "1h" }], parse: () => { throw new Error("drift"); } }), ctx(answer('{"x":1}')));
    expect(quotes[0]).toMatchObject({ status: "failed", payloadHash: sha256('{"x":1}') });
    expect(payloads).toEqual([{ hash: sha256('{"x":1}'), body: '{"x":1}' }]);
  });

  it("returns no payload for a quote with no hash (an upstream error, a skipped request)", async () => {
    expect((await collectAll(stub(), ctx(answer("nope", 500)))).payloads).toEqual([]);
    expect((await collectAll(stub({ request: () => ({ skip: "no key" }) }), ctx(answer("{}")))).payloads).toEqual([]);
  });

  it("redacts the stored body with the same rule as the reasons", async () => {
    const env = { NETTS_API_KEY: "secret-key-value-123" };
    const body = '{"echo":"secret-key-value-123","next":"https://stub.test/page?token=abc"}';
    const { quotes, payloads } = await collectAll(stub({ requests: [{ size: 20_000_000, term: "1h" }] }), ctx(answer(body), { redact: (s) => redactSecrets(s, env), env }));
    expect(payloads[0]!.body).toBe(redactSecrets(body, env));
    expect(payloads[0]!.body).not.toContain("secret-key-value-123");
    expect(payloads[0]!.body).not.toContain("token=abc");
    // The hash is of the body as received, so the row still matches what the venue sent.
    expect(payloads[0]!.hash).toBe(sha256(body));
    expect(quotes[0]!.payloadHash).toBe(sha256(body));
  });

  it("caps the stored body at the fetch size cap", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 10);
    const { payloads } = await collectAll(stub({ requests: [{ size: 20_000_000, term: "1h" }] }), ctx(answer("{}"), { redact: () => big }));
    expect(Buffer.byteLength(payloads[0]!.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("stores a marker, not the raw body, when redaction fails", async () => {
    const { payloads } = await collectAll(stub({ requests: [{ size: 20_000_000, term: "1h" }] }), ctx(answer('{"k":"v"}'), { redact: () => { throw new Error("boom"); } }));
    expect(payloads[0]!.body).toBe("[redaction failed]");
  });
});

describe("the published source", () => {
  const one = (url: string): VenueAdapter => stub({ requests: [{ size: 20_000_000, term: "1h" }], request: () => ({ url, init: {} }) });
  const live = (env: NodeJS.ProcessEnv) => ({ redact: (s: string) => redactSecrets(s, env), redactValues: (s: string) => redactConfiguredSecrets(s, env), env });

  it("keeps the endpoint's origin and path, drops the query, through the job's redactor", async () => {
    const { quotes } = await collectAll(one("https://api.venue.test/v2/estimate-buy-resource?resource_type=energy#frag"), ctx(answer("{}"), live({})));
    expect(quotes[0]!.source).toBe("https://api.venue.test/v2/estimate-buy-resource");
  });

  it("never carries a configured key value, in the path or anywhere else", async () => {
    const key = "configured-key-0123456789";
    const env = { NETTS_API_KEY: key };
    const { quotes } = await collectAll(one(`https://user:${key}@api.venue.test/v1/${key}/prices?apikey=${key}`), ctx(answer("{}"), live(env)));
    expect(quotes[0]!.source).toBe("https://api.venue.test/v1/[redacted]/prices");
    expect(quotes[0]!.source).not.toContain(key);
  });

  it("uses the context's value redactor when one is given (the job passes every secret in the process environment)", async () => {
    const trongrid = "trongrid-key-abcdefghij";
    const { quotes } = await collectAll(one(`https://api.venue.test/${trongrid}/q`), ctx(answer("{}"), { ...live({}), redactValues: (s) => s.split(trongrid).join("[redacted]") }));
    expect(quotes[0]!.source).toBe("https://api.venue.test/[redacted]/q");
  });

  it("keeps only the host when no value redactor is given, or when it throws", async () => {
    const url = "https://api.venue.test/v1/prices?x=1";
    expect((await collectAll(one(url), ctx(answer("{}"), { redact: (s) => redactSecrets(s, {}) }))).quotes[0]!.source).toBe("https://api.venue.test/[redacted]");
    expect((await collectAll(one(url), ctx(answer("{}"), { ...live({}), redactValues: () => { throw new Error("x"); } }))).quotes[0]!.source).toBe("https://api.venue.test/[redacted]");
  });

  it("keeps the venue name as the source of a request never sent", async () => {
    const { quotes } = await collectAll(stub({ requests: [{ size: 20_000_000, term: "1h" }], request: () => ({ skip: "no key" }) }), ctx(answer("{}"), live({})));
    expect(quotes[0]!.source).toBe("stub");
  });
});
