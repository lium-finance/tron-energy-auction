import { hourOf, msUntilMinute } from "../core/hour.js";
import { errorText } from "../core/errors.js";

/** A tick that has not finished by now stops holding up its schedule; the job itself keeps running. */
export const TICK_DEADLINE_MS = 15 * 60_000;
/** How long shutdown waits for a running hour before closing the database under it. */
export const SHUTDOWN_WAIT_MS = 20_000;

export type TickOutcome = "done" | "failed" | "timeout";

export interface TickOptions {
  /** Already redacting (makeLog); every error message goes through it. */
  log: (line: string) => void;
  deadlineMs?: number;
  /** The settled-promise of every job still running, for shutdown to wait on. The job is removed when it settles, even after its deadline. */
  running?: Set<Promise<unknown>>;
}

/**
 * Runs one tick's job with a deadline. Resolves when the job settles or the deadline passes, whichever is first,
 * and never rejects: a failure is logged, and a job past its deadline is logged and left running (its later
 * failure is still caught and logged) so the next tick can be scheduled. Overlap of the same hour is the hour
 * job's own in-flight guard's business.
 */
export async function runTick(label: string, job: () => Promise<unknown>, o: TickOptions): Promise<TickOutcome> {
  const deadlineMs = o.deadlineMs ?? TICK_DEADLINE_MS;
  let started: Promise<unknown>;
  try {
    started = Promise.resolve(job());
  } catch (e) {
    started = Promise.reject(e);
  }
  const settled: Promise<"done" | "failed"> = started.then(
    () => "done" as const,
    (e: unknown) => {
      o.log(`${label} failed: ${errorText(e)}`);
      return "failed" as const;
    },
  );
  o.running?.add(settled);
  void settled.finally(() => o.running?.delete(settled));

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  const outcome = await Promise.race([settled, deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") o.log(`${label} still running after ${Math.round(deadlineMs / 1000)} s; moving on, it keeps running`);
  return outcome;
}

export interface TickJobs {
  /** The :00 job, given the hour to run. */
  hour: (hour: number) => Promise<unknown>;
  /** The :05 job, given the moment the tick was due. */
  alerts: (due: Date) => Promise<unknown>;
}

export interface StartTicksOptions {
  log: (line: string) => void;
  running?: Set<Promise<unknown>>;
  jobs: TickJobs;
  deadlineMs?: number;
  now?: () => Date;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (t: unknown) => void;
}

/** A tick that fires more than this after it was due is logged as late. */
const LATE_MS = 60_000;

/**
 * Schedules the :00 hour job and the :05 alert job, each rescheduled with msUntilMinute after its run settles or
 * its deadline passes (runTick never rejects, so a failing or hung job is always rescheduled).
 *
 * The :00 job runs the hour the tick was due for, so a timer firing a moment early (12:59:59.995) still runs 13.
 * When it fires so late that the clock is already in a later hour (an event-loop stall or a suspended host), it
 * logs the lateness and runs the current hour instead, so no row is stamped with an hour that has passed.
 * `stop()` clears every pending timer and prevents a running job from rescheduling.
 */
export function startTicks(o: StartTicksOptions): { stop: () => void } {
  const now = o.now ?? (() => new Date());
  const setT = o.setTimeoutImpl ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearT = o.clearTimeoutImpl ?? ((t: unknown): void => clearTimeout(t as NodeJS.Timeout));
  const timers = new Set<unknown>();
  let stopped = false;

  const schedule = (minute: number, label: string, run: (due: Date, fired: Date) => Promise<unknown>): void => {
    if (stopped) return;
    const at = now();
    const delay = msUntilMinute(minute, at);
    const due = new Date(at.getTime() + delay);
    const t = setT(() => {
      timers.delete(t);
      if (stopped) return;
      const fired = now();
      if (fired.getTime() - due.getTime() > LATE_MS) o.log(`${label}: fired ${Math.round((fired.getTime() - due.getTime()) / 1000)} s late (due ${due.toISOString()})`);
      void runTick(label, () => run(due, fired), { log: o.log, running: o.running, deadlineMs: o.deadlineMs }).finally(() => schedule(minute, label, run));
    }, delay);
    timers.add(t);
  };

  schedule(0, "tick :00", (due, fired) => {
    const dueHour = hourOf(due);
    const current = hourOf(fired);
    if (current > dueHour) {
      o.log(`tick :00: due for hour ${dueHour} but the clock is in hour ${current}; running hour ${current} instead`);
      return o.jobs.hour(current);
    }
    return o.jobs.hour(dueHour);
  });
  schedule(5, "tick :05", (due) => o.jobs.alerts(due));

  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearT(t);
      timers.clear();
    },
  };
}

export interface ShutdownSteps {
  /** Stops scheduling ticks; nothing new starts after it. */
  stopTicks: () => void;
  /** Closes the HTTP server (serve.ts forces open connections closed after 5 s). */
  closeServer: () => Promise<void>;
  /** Settles when every running job has settled. */
  inFlight: () => Promise<unknown>;
  /** Closes the pool (the caller passes sql.end({ timeout: DB_END_TIMEOUT_S })). */
  endDb: () => Promise<void>;
  log: (line: string) => void;
  waitMs?: number;
}

/**
 * The SIGTERM/SIGINT sequence: stop the ticks, close the server, wait for a running hour up to 20 s, close the
 * database. Each step is logged; a failing step is logged and the next one still runs. Never rejects; the caller exits 0.
 */
export async function shutdown(signal: string, s: ShutdownSteps): Promise<void> {
  const waitMs = s.waitMs ?? SHUTDOWN_WAIT_MS;
  s.log(`shutdown: ${signal} received; stopping the ticks`);
  try {
    s.stopTicks();
  } catch (e) {
    s.log(`shutdown: stopping the ticks failed: ${errorText(e)}`);
  }

  s.log("shutdown: closing the server");
  try {
    await s.closeServer();
    s.log("shutdown: server closed");
  } catch (e) {
    s.log(`shutdown: closing the server failed: ${errorText(e)}`);
  }

  s.log(`shutdown: waiting up to ${Math.round(waitMs / 1000)} s for running jobs`);
  let timer: NodeJS.Timeout | undefined;
  const waited = await Promise.race([
    Promise.resolve()
      .then(() => s.inFlight())
      .then(
        () => "settled" as const,
        () => "settled" as const,
      ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    }),
  ]);
  clearTimeout(timer);
  s.log(waited === "settled" ? "shutdown: no job running" : `shutdown: a job is still running after ${Math.round(waitMs / 1000)} s; closing the database under it`);

  s.log("shutdown: closing the database");
  try {
    await s.endDb();
    s.log("shutdown: database closed");
  } catch (e) {
    s.log(`shutdown: closing the database failed: ${errorText(e)}`);
  }
  s.log("shutdown: done");
}
