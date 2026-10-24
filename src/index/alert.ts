import { hourOf, hourStart } from "../core/hour.js";
import { INSTRUMENT } from "../core/types.js";
import type { Sql } from "./db.js";
import { redactSecrets } from "./redact.js";
import { errorMessage } from "../core/errors.js";

export const THIN_SHARE_LIMIT = 0.1;
/** The thin share is judged over a full day of prints. */
export const THIN_SHARE_WINDOW = 24;
/** The dead-man ping and the alert webhook each get this long; neither may hold up the job that sends it. */
const OUTBOUND_TIMEOUT_MS = 5_000;

/** Releases the connection held by a response whose body nobody reads. Never throws. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}

/**
 * The dead-man ping, sent after every successful publish. One GET, five-second timeout, never throws.
 * The URL is a credential (the path carries the monitor's id), so it is never logged: a failure logs the
 * status code or an error message with the URL (and anything else secret-looking) redacted.
 */
export async function pingHealthcheck(url: string, f: typeof fetch = fetch, log: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): Promise<boolean> {
  try {
    const res = await f(url, { method: "GET", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
    await drain(res);
    if (!res.ok) {
      log(`[ping] monitor returned ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    let text: string;
    try {
      text = redactSecrets(errorMessage(e), { ...process.env, HEALTHCHECK_PING_URL: url });
    } catch {
      text = "[redacted]";
    }
    try {
      log(`[ping] failed: ${text}`);
    } catch {
      // a logger that throws must not break the ping's never-throws promise
    }
    return false;
  }
}

/** The one place a message leaves for a third party, so redaction lives here. */
export async function postAlert(url: string | null, text: string, f: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const safe = redactSecrets(text, env);
  process.stderr.write(`[alert] ${safe}\n`);
  if (!url) return false;
  try {
    const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: safe }), signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
    await drain(res);
    if (!res.ok) {
      process.stderr.write(`[alert] webhook returned ${res.status}; the alert above was not delivered\n`);
      return false;
    }
    return true;
  } catch (e) {
    process.stderr.write(`[alert] webhook post failed: ${redactSecrets(errorMessage(e), env)}; not delivered\n`);
    return false;
  }
}

/**
 * Sends one message per (kind, UTC day). The claim is the alerts row, inserted first so two ticks cannot both send;
 * if the send reports failure (webhook down) or throws, the claim is released so the next tick retries.
 */
async function sendOncePerDay(sql: Sql, kind: string, day: string, text: string, send: (text: string) => Promise<boolean>): Promise<boolean> {
  const claimed = await sql`insert into alerts (kind, utc_day) values (${kind}, ${day}) on conflict do nothing returning kind`;
  if (claimed.length === 0) return false;
  let sent = false;
  try {
    sent = await send(text);
  } finally {
    if (!sent) await sql`delete from alerts where kind = ${kind} and utc_day = ${day}`;
  }
  return sent;
}

/**
 * The in-process :05 job. Over the last 24 hours of prints, the share that is `thin`; above 10 % one message
 * a UTC day, deduplicated through the alerts table so a restart cannot resend it. Only `thin` counts, not `no_index`:
 * almost every hour is `no_index` by design (only one venue can quote the instrument), so counting it would
 * fire the alert every day and say nothing. `thin` is the failure worth hearing about: venues were quoting and
 * too few were live. Only prints from hour (now - 24) to now count, and a full 24 of them are needed before it
 * can alert: a fresh database or a long gap would otherwise judge a share on two or three rows, or on stale ones.
 * (The window is 25 hours wide so a current-hour print that has not landed yet does not silence the check.)
 * If the webhook is down (`send` returns false) the day's claim is released so the next tick retries.
 */
export async function thinShareCheck(sql: Sql, send: (text: string) => Promise<boolean>, now: Date = new Date()): Promise<{ share: number; sent: boolean }> {
  const current = hourOf(now);
  const rows = await sql<{ status: string }[]>`select status from prints where hour >= ${current - THIN_SHARE_WINDOW} and hour <= ${current} order by hour desc limit ${THIN_SHARE_WINDOW}`;
  if (rows.length === 0) return { share: 0, sent: false };
  const thin = rows.filter((r) => r.status === "thin").length;
  const share = thin / rows.length;
  if (rows.length < THIN_SHARE_WINDOW || share <= THIN_SHARE_LIMIT) return { share, sent: false };
  const day = now.toISOString().slice(0, 10);
  const sent = await sendOncePerDay(sql, "thin-share", day, `Tron energy index: ${thin} of the last ${rows.length} prints are thin (${Math.round(share * 100)} %).`, send);
  return { share, sent };
}

/**
 * The in-process :05 job for a feed that prints but has no data behind it. Almost every hour is `no_index` by
 * design, so a dead collector prints and pings exactly like a healthy one; the thin share cannot see it. Over the
 * last two prints (consecutive hours, the latest no more than 2 hours old) it alerts, once a UTC day, when any of
 * these hold in both hours: (a) no venue could fill the instrument (depthAwareCount 0); (b) every 1h quote is
 * failed or missing; (c) there is no chain row, so the chain read failed. A stale feed is the dead-man monitor's job.
 */
export async function degradedCheck(sql: Sql, send: (text: string) => Promise<boolean>, now: Date = new Date()): Promise<{ degraded: string[]; sent: boolean }> {
  const none = { degraded: [] as string[], sent: false };
  const prints = await sql<{ hour: string; depth_aware_count: number }[]>`select hour, depth_aware_count from prints order by hour desc limit 2`;
  if (prints.length < 2) return none;
  const latest = Number(prints[0]!.hour);
  const previous = Number(prints[1]!.hour);
  if (latest !== previous + 1 || hourOf(now) - latest > 2) return none;
  const hours = [latest, previous];

  const degraded: string[] = [];
  if (prints.every((r) => Number(r.depth_aware_count) === 0)) degraded.push(`no venue could fill the instrument (TronSave down, or its depth below ${INSTRUMENT.units.toLocaleString("en-US")} units)`);

  const usable = await sql<{ hour: string }[]>`select distinct hour from quotes where hour in ${sql(hours)} and term = '1h' and status not in ('failed', 'missing')`;
  if (usable.length === 0) degraded.push("every 1h quote failed or is missing");

  const chain = await sql<{ hour: string }[]>`select hour from chain where hour in ${sql(hours)}`;
  if (chain.length === 0) degraded.push("no chain read (energy fee and weight unknown)");

  if (degraded.length === 0) return none;
  const day = now.toISOString().slice(0, 10);
  const label = hours.slice().reverse().map((h) => `${h} (${hourStart(h).toISOString().slice(0, 13)}Z)`).join(" and ");
  const sent = await sendOncePerDay(sql, "degraded", day, `Tron energy index: the data is degraded in hours ${label}: ${degraded.join("; ")}.`, send);
  return { degraded, sent };
}
