import postgres from "postgres";
import type { ChainParams, Print, Quote, ResourceRead } from "../core/types.js";

export type Sql = postgres.Sql<Record<string, never>>;

/** A connection string carries a password and is never printed raw. */
export function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "[unparseable database url]";
  }
}

/** Seconds sql.end waits for queries in flight at shutdown before closing the connections (main.ts and every script). */
export const DB_END_TIMEOUT_S = 5;

/** The server-side cap on every pooled statement (the process and the scripts); the migration connection has none. */
export const STATEMENT_TIMEOUT_MS = 30_000;

export interface DbOptions {
  /** Server-side cap on every statement, in milliseconds; a hung query fails instead of holding the hour. Unset: no cap (the migration connection). */
  statementTimeoutMs?: number;
}

/** Connections in the service's pool: the hour job, the alert job and the start-up republish can overlap. */
export const SERVICE_POOL_SIZE = 4;
/** Seconds an idle pooled connection is kept before it is closed. */
const IDLE_TIMEOUT_S = 20;
/** Seconds a new connection may take before the attempt fails. */
const CONNECT_TIMEOUT_S = 10;

export function createDb(url: string, max = SERVICE_POOL_SIZE, o: DbOptions = {}): Sql {
  return postgres(url, {
    max,
    idle_timeout: IDLE_TIMEOUT_S,
    connect_timeout: CONNECT_TIMEOUT_S,
    onnotice: () => {},
    ...(o.statementTimeoutMs !== undefined ? { connection: { statement_timeout: o.statementTimeoutMs } } : {}),
  });
}

/** Inserts the hour's quote rows in one statement; a row that already exists for (hour, venue, size, term) is left as it was. */
export async function insertQuotes(sql: Sql, quotes: readonly Quote[]): Promise<void> {
  if (quotes.length === 0) return;
  const rows = quotes.map((q) => ({
    hour: q.hour, venue: q.venue, size: q.size, term: q.term, sun_per_unit: q.sunPerUnit, depth: q.depth,
    read_at: q.readAt, source: q.source, status: q.status, reason: q.reason, payload_hash: q.payloadHash,
  }));
  await sql`insert into quotes ${sql(rows, "hour", "venue", "size", "term", "sun_per_unit", "depth", "read_at", "source", "status", "reason", "payload_hash")}
    on conflict (hour, venue, size, term) do nothing`;
}

/** Returns true when this call inserted the row, false when the hour was already printed. */
export async function insertPrint(sql: Sql, p: Print): Promise<boolean> {
  const rows = await sql`insert into prints (hour, median, cheapest, dearest, live_count, depth_aware_count, status, method_version, printed_at)
    values (${p.hour}, ${p.median}, ${p.cheapest}, ${p.dearest}, ${p.liveCount}, ${p.depthAwareCount}, ${p.status}, ${p.methodVersion}, ${p.printedAt})
    on conflict (hour) do nothing returning hour`;
  return rows.length === 1;
}

export async function insertChain(sql: Sql, c: ChainParams): Promise<void> {
  await sql`insert into chain (hour, energy_fee_sun, total_energy_weight_trx, total_energy_limit, trx_usd, read_at)
    values (${c.hour}, ${c.energyFeeSun}, ${c.totalEnergyWeightTrx}, ${c.totalEnergyLimit}, ${c.trxUsd}, ${c.readAt})
    on conflict (hour) do nothing`;
}

export async function insertVerification(sql: Sql, r: ResourceRead): Promise<void> {
  await sql`insert into verification (hour, wallet, energy_limit, energy_used, read_at, source)
    values (${r.hour}, ${r.wallet}, ${r.energyLimit}, ${r.energyUsed}, ${r.readAt}, ${r.source})
    on conflict (hour, wallet) do nothing`;
}

const MS_PER_DAY = 86_400_000;

/** Raw venue payloads are kept this many days as evidence behind the quote rows, then deleted by the :05 job (wire.ts alertJob). */
export const PAYLOAD_RETENTION_DAYS = 30;

/**
 * Stores the hour's raw payloads, one row per hash (one body can back several quotes). A body already stored keeps
 * its text, but its age restarts, so a body seen again (an unchanged catalog) is kept 30 days after its last quote.
 */
export async function insertPayloads(sql: Sql, payloads: readonly { hash: string; body: string }[]): Promise<void> {
  const rows = [...new Map(payloads.map((p) => [p.hash, { payload_hash: p.hash, body: p.body }])).values()];
  if (rows.length === 0) return;
  await sql`insert into payloads ${sql(rows, "payload_hash", "body")}
    on conflict (payload_hash) do update set stored_at = now()`;
}

/** Deletes the payloads stored more than PAYLOAD_RETENTION_DAYS before `now`; returns how many. */
export async function prunePayloads(sql: Sql, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PAYLOAD_RETENTION_DAYS * MS_PER_DAY);
  const rows = await sql`delete from payloads where stored_at < ${cutoff} returning payload_hash`;
  return rows.length;
}

/**
 * The newest energy fee stored for `hour` or earlier, and the hour it was read for; null when there is none.
 * A row for a later hour is never used, so a rerun of an old hour cannot take a fee from its future.
 */
export async function lastEnergyFeeRow(sql: Sql, hour: number): Promise<{ fee: number; hour: number } | null> {
  const rows = await sql<{ energy_fee_sun: number; hour: number }[]>`select energy_fee_sun, hour from chain where hour <= ${hour} order by hour desc limit 1`;
  const r = rows[0];
  return r ? { fee: Number(r.energy_fee_sun), hour: Number(r.hour) } : null;
}

export async function hasPrint(sql: Sql, hour: number): Promise<boolean> {
  const rows = await sql`select 1 from prints where hour = ${hour}`;
  return rows.length === 1;
}

function toPrint(r: Record<string, unknown>): Print {
  const n = (v: unknown): number | null => (v === null ? null : Number(v));
  return { hour: Number(r.hour), median: n(r.median), cheapest: n(r.cheapest), dearest: n(r.dearest), liveCount: Number(r.live_count), depthAwareCount: Number(r.depth_aware_count), status: r.status as Print["status"], methodVersion: String(r.method_version), printedAt: r.printed_at as Date };
}

export async function lastPrint(sql: Sql): Promise<Print | null> {
  const rows = await sql<Record<string, unknown>[]>`select * from prints order by hour desc limit 1`;
  return rows[0] ? toPrint(rows[0]) : null;
}

export async function printForHour(sql: Sql, hour: number): Promise<Print | null> {
  const rows = await sql<Record<string, unknown>[]>`select * from prints where hour = ${hour}`;
  return rows[0] ? toPrint(rows[0]) : null;
}

export async function allPrints(sql: Sql): Promise<Print[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from prints order by hour asc`;
  return rows.map(toPrint);
}

function toQuote(r: Record<string, unknown>): Quote {
  return {
    hour: Number(r.hour), venue: String(r.venue), size: Number(r.size), term: r.term as Quote["term"],
    sunPerUnit: r.sun_per_unit === null ? null : Number(r.sun_per_unit), depth: r.depth === null ? null : Number(r.depth),
    readAt: r.read_at as Date, source: String(r.source), status: r.status as Quote["status"], reason: r.reason as string | null, payloadHash: r.payload_hash as string | null,
  };
}

export async function quotesForHour(sql: Sql, hour: number): Promise<Quote[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from quotes where hour = ${hour} order by venue, term, size`;
  return rows.map(toQuote);
}

/** Every stored quote from hour `from` to hour `to`, both inclusive, oldest hour first. */
export async function quotesBetween(sql: Sql, from: number, to: number): Promise<Quote[]> {
  const rows = await sql<Record<string, unknown>[]>`select * from quotes where hour between ${from} and ${to} order by hour, venue, size, term`;
  return rows.map(toQuote);
}

export async function chainForHour(sql: Sql, hour: number): Promise<ChainParams | null> {
  const rows = await sql<Record<string, unknown>[]>`select * from chain where hour = ${hour}`;
  const r = rows[0];
  if (!r) return null;
  return { hour: Number(r.hour), energyFeeSun: Number(r.energy_fee_sun), totalEnergyWeightTrx: Number(r.total_energy_weight_trx), totalEnergyLimit: Number(r.total_energy_limit), trxUsd: r.trx_usd === null ? null : Number(r.trx_usd), readAt: r.read_at as Date };
}
