import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchQuote } from "../../src/collectors/http.js";

type Handler = (call: number) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  let call = 0;
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    call += 1;
    const signal = init?.signal;
    const res = handler(call);
    if (signal) {
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        Promise.resolve(res).then(resolve, reject);
      });
    }
    return res;
  }) as unknown as typeof fetch;
}

const never = (): Promise<Response> => new Promise(() => {});

afterEach(() => vi.useRealTimers());

describe("fetchQuote", () => {
  it("returns ok with the body and a hash on 200", async () => {
    const f = fakeFetch(() => new Response('{"a":1}', { status: 200 }));
    const r = await fetchQuote("https://x.test/q", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: f });
    expect(r).toMatchObject({ ok: true, status: 200, body: '{"a":1}' });
    expect(r.ok && r.payloadHash).toHaveLength(64);
  });
  it("retries once at retryAtMs on a hung request and gives up at the budget", async () => {
    vi.useFakeTimers();
    const f = fakeFetch(never);
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
    expect(r.ok === false && r.reason).toBe("timed out after 20000 ms (2 attempts)");
  });
  it("backs off once on 429 inside the budget and returns the second answer", async () => {
    vi.useFakeTimers();
    const f = fakeFetch((n) => (n === 1 ? new Response("slow down", { status: 429 }) : new Response("{}", { status: 200 })));
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(2_001);
    const r = await p;
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("returns a failure with a 200-character excerpt on 5xx and on HTML with 200", async () => {
    const html = "<!doctype html><html><body>maintenance</body></html>";
    const f5 = fakeFetch(() => new Response("x".repeat(500), { status: 503 }));
    const r5 = await fetchQuote("https://x.test/q", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: f5 });
    expect(r5).toMatchObject({ ok: false, kind: "upstream", status: 503 });
    expect(r5.ok === false && r5.reason.length).toBeLessThanOrEqual(230);
    const fh = fakeFetch(() => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    const rh = await fetchQuote("https://x.test/q", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: fh });
    expect(rh).toMatchObject({ ok: false, kind: "not-json" });
  });
  it("accepts an HTML body with expect html and fails it as not-json by default", async () => {
    const f = fakeFetch(() => new Response("<html><td>65k</td></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const html = await fetchQuote("https://x.test/p", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: f, expect: "html" });
    expect(html).toMatchObject({ ok: true, status: 200, body: "<html><td>65k</td></html>" });
    expect(html.ok && html.payloadHash).toHaveLength(64);
    const byDefault = await fetchQuote("https://x.test/p", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: f });
    expect(byDefault).toMatchObject({ ok: false, kind: "not-json" });
    const asJson = await fetchQuote("https://x.test/p", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: f, expect: "json" });
    expect(asJson).toMatchObject({ ok: false, kind: "not-json" });
  });
  it("still fails a 5xx with expect html", async () => {
    const f = fakeFetch(() => new Response("<html>down</html>", { status: 503 }));
    const r = await fetchQuote("https://x.test/p", {}, { budgetMs: 1000, retryAtMs: 500, fetchImpl: f, expect: "html" });
    expect(r).toMatchObject({ ok: false, kind: "upstream", status: 503 });
  });
  it("makes exactly one request when the first answers fast, even after retryAtMs passes", async () => {
    vi.useFakeTimers();
    const f = fakeFetch(() => new Response('{"a":1}', { status: 200 }));
    const r = await fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f });
    expect(r).toMatchObject({ ok: true, status: 200 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("leaves no timer behind after it returns, on success, 429 and timeout", async () => {
    vi.useFakeTimers();
    const ok = await fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })) });
    expect(ok.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const f429 = fakeFetch(() => new Response("no", { status: 429 }));
    const p429 = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f429 });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await p429).toMatchObject({ ok: false, kind: "rate-limited", reason: "429 twice" });
    expect(vi.getTimerCount()).toBe(0);

    const pt = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: fakeFetch(never) });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await pt).toMatchObject({ ok: false, kind: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts the hung first attempt when the second one answers", async () => {
    vi.useFakeTimers();
    const f = fakeFetch((n) => (n === 1 ? never() : new Response('{"b":2}', { status: 200 })));
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await p;
    expect(r).toMatchObject({ ok: true, body: '{"b":2}' });
    const calls = (f as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1].signal!.aborted).toBe(true);
    expect(calls[1]![1].signal!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts both attempts when one fails with a network error while the other hangs", async () => {
    vi.useFakeTimers();
    const f = fakeFetch((n) => (n === 1 ? new Promise<Response>((_, reject) => setTimeout(() => reject(new TypeError("fetch failed")), 12_000)) : never()));
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(12_001);
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "network", status: null, reason: "fetch failed" });
    const calls = (f as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1].signal!.aborted).toBe(true);
    expect(calls[1]![1].signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out within the budget when the body stalls after the headers", async () => {
    vi.useFakeTimers();
    const stalled = (): Response => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const f = fakeFetch(stalled);
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 1_000, retryAtMs: 500, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(1_001);
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns too-large and leaves no timer when a streamed body passes maxBytes", async () => {
    vi.useFakeTimers();
    const MiB = 1024 * 1024;
    let sent = 0;
    const big = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            sent += 1;
            c.enqueue(new Uint8Array(MiB).fill(32));
            if (sent === 3) c.close();
          },
        }),
        { status: 200 },
      );
    const r = await fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: fakeFetch(big) });
    expect(r).toMatchObject({ ok: false, kind: "too-large", status: 200, reason: `body larger than ${2 * MiB} bytes` });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns too-large from a content-length over the cap without reading the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              pulls += 1;
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } },
        ),
    );
    const r = await fetchQuote("https://x.test/q", {}, { budgetMs: 1_000, retryAtMs: 500, maxBytes: 1_000, fetchImpl: f });
    expect(r).toMatchObject({ ok: false, kind: "too-large", status: 200, reason: "body larger than 1000 bytes" });
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });
  it("reads at most 1024 bytes of a failure body", async () => {
    let sent = 0;
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              sent += 1;
              c.enqueue(new TextEncoder().encode("e".repeat(1024)));
            },
          }),
          { status: 500 },
        ),
    );
    const r = await fetchQuote("https://x.test/q", {}, { budgetMs: 1_000, retryAtMs: 500, fetchImpl: f });
    expect(r).toMatchObject({ ok: false, kind: "upstream", status: 500 });
    expect(r.ok === false && r.reason).toBe(`500: ${"e".repeat(200)}`);
    expect(sent).toBeLessThanOrEqual(3);
  });
  it("fails a 429 at once when less budget is left than the backoff", async () => {
    vi.useFakeTimers();
    const f = fakeFetch(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("no", { status: 429 })), 600)));
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 1_000, retryAtMs: 900, backoffMs: 2_000, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(601);
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "rate-limited", status: 429 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports a timeout, counting the retry as an attempt, when the 429 retry hangs", async () => {
    vi.useFakeTimers();
    const f = fakeFetch((n) => (n === 1 ? new Response("no", { status: 429 }) : never()));
    const p = fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: f });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(18_001);
    const r = await p;
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
    expect(r.ok === false && r.reason).toBe("timed out after 20000 ms (2 attempts)");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects bad options without calling fetch", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const bad = [
      { budgetMs: 0, retryAtMs: 500 },
      { budgetMs: Number.NaN, retryAtMs: 500 },
      { budgetMs: 1_000, retryAtMs: Number.POSITIVE_INFINITY },
      { budgetMs: 1_000, retryAtMs: 1_000 },
      { budgetMs: 1_000, retryAtMs: 500, maxBytes: 0 },
      { budgetMs: 1_000, retryAtMs: 500, expect: "xml" as "json" },
    ];
    for (const o of bad) {
      const r = await fetchQuote("https://x.test/q", {}, { ...o, fetchImpl: f });
      expect(r).toMatchObject({ ok: false, kind: "network", status: null, reason: "invalid fetch options" });
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("leaves no timer behind on the upstream and not-json paths", async () => {
    vi.useFakeTimers();
    const r5 = await fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: fakeFetch(() => new Response("bad", { status: 502 })) });
    expect(r5).toMatchObject({ ok: false, kind: "upstream" });
    expect(vi.getTimerCount()).toBe(0);
    const rh = await fetchQuote("https://x.test/q", {}, { budgetMs: 20_000, retryAtMs: 10_000, fetchImpl: fakeFetch(() => new Response("<html></html>", { status: 200 })) });
    expect(rh).toMatchObject({ ok: false, kind: "not-json" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
