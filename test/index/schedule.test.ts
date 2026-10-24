import { afterEach, describe, expect, it, vi } from "vitest";
import { hourOf } from "../../src/core/hour.js";
import { runTick, shutdown, startTicks } from "../../src/index/schedule.js";

afterEach(() => { vi.useRealTimers(); });

describe("runTick", () => {
  it("reports a finished job and removes it from the running set", async () => {
    const running = new Set<Promise<unknown>>();
    expect(await runTick("t", async () => 1, { log: () => {}, running })).toBe("done");
    await Promise.resolve();
    expect(running.size).toBe(0);
  });
  it("logs a failure and never rejects", async () => {
    const lines: string[] = [];
    expect(await runTick("tick :00", async () => { throw new Error("boom"); }, { log: (l) => lines.push(l) })).toBe("failed");
    expect(lines).toEqual(["tick :00 failed: Error: boom"]);
    expect(await runTick("sync", () => { throw new Error("sync boom"); }, { log: (l) => lines.push(l) })).toBe("failed");
  });
  it("gives up waiting at the deadline, leaves the job running, and still logs its later failure", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const running = new Set<Promise<unknown>>();
    let fail!: (e: Error) => void;
    const job = new Promise<never>((_, reject) => { fail = reject; });
    const outcome = runTick("tick :00", () => job, { log: (l) => lines.push(l), running, deadlineMs: 15 * 60_000 });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(await outcome).toBe("timeout");
    expect(lines[0]).toContain("still running after 900 s");
    expect(running.size).toBe(1);
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(lines[1]).toBe("tick :00 failed: Error: late");
    expect(running.size).toBe(0);
  });
});

describe("shutdown", () => {
  const steps = (order: string[], over: Partial<Parameters<typeof shutdown>[1]> = {}) => ({
    stopTicks: vi.fn(() => { order.push("stopTicks"); }),
    closeServer: vi.fn(async () => { order.push("closeServer"); }),
    inFlight: vi.fn(async () => { order.push("inFlight"); }),
    endDb: vi.fn(async () => { order.push("endDb"); }),
    log: () => {},
    ...over,
  });

  it("stops the ticks, closes the server, waits for jobs, then closes the database", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const s = steps(order, { log: (l: string) => lines.push(l) });
    await shutdown("SIGTERM", s);
    expect(order).toEqual(["stopTicks", "closeServer", "inFlight", "endDb"]);
    expect(s.closeServer).toHaveBeenCalledTimes(1);
    expect(s.endDb).toHaveBeenCalledTimes(1);
    expect(lines[0]).toBe("shutdown: SIGTERM received; stopping the ticks");
    expect(lines.at(-1)).toBe("shutdown: done");
  });

  it("closes the database after the wait limit when a job hangs", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const lines: string[] = [];
    const s = steps(order, { inFlight: vi.fn(() => new Promise(() => {})), log: (l: string) => lines.push(l), waitMs: 20_000 });
    const done = shutdown("SIGINT", s);
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(s.endDb).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes("still running after 20 s"))).toBe(true);
  });

  it("still closes the database when closing the server fails", async () => {
    const order: string[] = [];
    const s = steps(order, { closeServer: vi.fn(async () => { throw new Error("not running"); }) });
    await shutdown("SIGTERM", s);
    expect(s.endDb).toHaveBeenCalledTimes(1);
  });
});

describe("startTicks", () => {
  const at = (iso: string) => new Date(iso);
  const H13 = hourOf(at("2026-10-28T13:00:00Z"));
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  /** A hand-driven clock and timer list: the test decides when each callback fires and what the clock reads then. */
  function harness(start: string) {
    let clock = at(start);
    const pending: { id: number; fn: () => void; ms: number; scheduledAt: Date }[] = [];
    const cleared: number[] = [];
    let next = 0;
    return {
      set: (iso: string) => { clock = at(iso); },
      pending,
      cleared,
      now: () => clock,
      setTimeoutImpl: (fn: () => void, ms: number) => { const id = ++next; pending.push({ id, fn, ms, scheduledAt: clock }); return id; },
      clearTimeoutImpl: (t: unknown) => { cleared.push(t as number); },
      /** Fires the oldest pending :00 timer (the one scheduled for minute 0). */
      fireHourTimer: () => {
        const i = pending.findIndex((p) => new Date(p.scheduledAt.getTime() + p.ms).getUTCMinutes() === 0);
        const [t] = pending.splice(i, 1);
        t!.fn();
      },
    };
  }

  it("a callback that fires a moment early (12:59:59.995) runs hour 13", async () => {
    const h = harness("2026-10-28T12:30:00Z");
    const hour = vi.fn(async (_h: number) => {});
    startTicks({ log: () => {}, jobs: { hour, alerts: async () => {} }, now: h.now, setTimeoutImpl: h.setTimeoutImpl, clearTimeoutImpl: h.clearTimeoutImpl });
    expect(h.pending.map((p) => p.ms)).toEqual([30 * 60_000, 35 * 60_000]);
    h.set("2026-10-28T12:59:59.995Z");
    h.fireHourTimer();
    await flush();
    expect(hour).toHaveBeenCalledWith(H13);
  });

  it("a late callback still inside the hour (13:20) runs hour 13 without relabelling", async () => {
    const h = harness("2026-10-28T12:30:00Z");
    const hour = vi.fn(async (_h: number) => {});
    const lines: string[] = [];
    startTicks({ log: (l) => lines.push(l), jobs: { hour, alerts: async () => {} }, now: h.now, setTimeoutImpl: h.setTimeoutImpl, clearTimeoutImpl: h.clearTimeoutImpl });
    h.set("2026-10-28T13:20:00Z");
    h.fireHourTimer();
    await flush();
    expect(hour).toHaveBeenCalledWith(H13);
    expect(lines.some((l) => l.includes("fired 1200 s late"))).toBe(true);
    expect(lines.some((l) => l.includes("instead"))).toBe(false);
  });

  it("a stall into 14:05 runs hour 14 and says so", async () => {
    const h = harness("2026-10-28T12:30:00Z");
    const hour = vi.fn(async (_h: number) => {});
    const lines: string[] = [];
    startTicks({ log: (l) => lines.push(l), jobs: { hour, alerts: async () => {} }, now: h.now, setTimeoutImpl: h.setTimeoutImpl, clearTimeoutImpl: h.clearTimeoutImpl });
    h.set("2026-10-28T14:05:00Z");
    h.fireHourTimer();
    await flush();
    expect(hour).toHaveBeenCalledWith(H13 + 1);
    expect(hour).not.toHaveBeenCalledWith(H13);
    expect(lines.some((l) => l.includes(`due for hour ${H13}`) && l.includes(`running hour ${H13 + 1} instead`))).toBe(true);
  });

  it("a job that hangs past the deadline still gets the next :00", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-10-28T12:30:00Z"));
    const hour = vi.fn((_h: number) => new Promise<never>(() => {}));
    const lines: string[] = [];
    const ticks = startTicks({ log: (l) => lines.push(l), jobs: { hour, alerts: async () => {} } });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(hour).toHaveBeenLastCalledWith(H13);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(hour).toHaveBeenCalledTimes(2);
    expect(hour).toHaveBeenLastCalledWith(H13 + 1);
    expect(lines.some((l) => l.includes("tick :00 still running after 900 s"))).toBe(true);
    ticks.stop();
  });

  it("a failing job is logged and rescheduled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at("2026-10-28T12:30:00Z"));
    const hour = vi.fn(async (_h: number) => { throw new Error("db down"); });
    const alerts = vi.fn(async (_due: Date) => { throw new Error("webhook"); });
    const lines: string[] = [];
    const ticks = startTicks({ log: (l) => lines.push(l), jobs: { hour, alerts } });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(hour.mock.calls.map((c) => c[0])).toEqual([H13, H13 + 1]);
    expect(alerts).toHaveBeenCalledTimes(2);
    expect(alerts.mock.calls[0]![0]).toEqual(at("2026-10-28T13:05:00Z"));
    expect(lines.filter((l) => l === "tick :00 failed: Error: db down")).toHaveLength(2);
    ticks.stop();
  });

  it("stop() during a running job clears the pending timers and prevents rescheduling", async () => {
    const h = harness("2026-10-28T12:30:00Z");
    let finish!: () => void;
    const hour = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const ticks = startTicks({ log: () => {}, jobs: { hour, alerts: async () => {} }, now: h.now, setTimeoutImpl: h.setTimeoutImpl, clearTimeoutImpl: h.clearTimeoutImpl });
    h.set("2026-10-28T13:00:00Z");
    h.fireHourTimer();
    await flush();
    expect(hour).toHaveBeenCalledTimes(1);
    const alertsTimer = h.pending[0]!.id;
    ticks.stop();
    expect(h.cleared).toEqual([alertsTimer]);
    const before = h.pending.length;
    finish();
    await flush();
    expect(h.pending.length).toBe(before);
  });
});
