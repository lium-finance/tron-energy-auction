import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hourStart } from "../core/hour.js";
import { isLive, MIN_LIVE, STALE_MS } from "../core/print.js";
import { INSTRUMENT, type Print, type Quote } from "../core/types.js";
import { renderPage } from "./page.js";

export interface ChainSummary {
  energyFeeSun: number;
  totalEnergyWeightTrx: number;
  trxUsd: number | null;
}

export interface Latest {
  hour: number;
  hourStartUtc: string;
  instrument: { units: number; termHours: number; unit: "sun per energy unit" };
  print: Omit<Print, "hour" | "methodVersion" | "printedAt"> & { printedAt: string };
  methodVersion: string;
  method: string;
  /** `countsTowardIndex` is the print rule's own test (core/print.ts isLive) for a live quote for the instrument, computed at `printedAt` (the same `now` print() used), and false for every quote unless the print is live: on a thin or no_index hour no price is published, so nothing counts. */
  quotes: (Omit<Quote, "readAt"> & { readAt: string; countsTowardIndex: boolean })[];
  series: Record<"1d" | "7d" | "14d", { venue: string; sunPerUnitDay: number }[]>;
  chain: ChainSummary | null;
}

const UNITS = INSTRUMENT.units.toLocaleString("en-US");
const STALE_MINUTES = STALE_MS / 60_000;
const HOURS = `${INSTRUMENT.termHours} ${INSTRUMENT.termHours === 1 ? "hour" : "hours"}`;

/** The published method, built from the constants the print rule runs on so the text cannot drift from it. */
export const METHOD_TEXT = [
  `One print an hour: the median of live quotes for ${UNITS} energy units delivered for ${HOURS}, in sun per unit.`,
  "Each venue counts once, by its latest answer for that hour, whatever its status.",
  `A quote is live when its status is ok, it is for ${UNITS} units and a ${HOURS} term, its reported depth covers ${UNITS} units, and it was read less than ${STALE_MINUTES} minutes before the print.`,
  "Quotes below 1 sun or above the chain's energy fee are rejected and never become prices (the fee falls back to the last stored fee when the chain read fails).",
  "With an even number of live quotes the median is the mean of the two middle values.",
  `Fewer than ${MIN_LIVE} venues able to fill ${UNITS} units: no median is published and the ladder is shown with a flag.`,
  `Fewer than ${MIN_LIVE} live quotes: the print is marked thin and publishes no price.`,
  "Prices are never extrapolated or backfilled; a missing hour stays missing.",
].join(" ");

/**
 * The print as the feed publishes it: on a no_index or thin hour no price field is published, so nothing in the
 * feed can be read as the index (a thin median rests on too few live quotes to stand as a price). The stored print keeps its raw values.
 */
export function publicPrint(p: Print): Print {
  return p.status === "live" ? p : { ...p, median: null, cheapest: null, dearest: null };
}

/**
 * The feed's latest.json. Quote reasons and sources are published exactly as stored: the collectors redact them
 * before they are stored, and nothing here adds a wallet address or a secret.
 */
export function buildLatest(p: Print, quotes: readonly Quote[], chain: ChainSummary | null): Latest {
  const { hour, methodVersion, printedAt, ...rest } = publicPrint(p);
  const series = { "1d": [] as { venue: string; sunPerUnitDay: number }[], "7d": [] as { venue: string; sunPerUnitDay: number }[], "14d": [] as { venue: string; sunPerUnitDay: number }[] };
  for (const q of quotes) {
    if (q.term !== "1h" && q.sunPerUnit !== null && (q.status === "ok" || q.status === "depth-unknown")) series[q.term].push({ venue: q.venue, sunPerUnitDay: q.sunPerUnit });
  }
  return {
    hour,
    hourStartUtc: hourStart(hour).toISOString(),
    instrument: { units: INSTRUMENT.units, termHours: INSTRUMENT.termHours, unit: "sun per energy unit" },
    print: { ...rest, printedAt: printedAt.toISOString() },
    methodVersion,
    method: METHOD_TEXT,
    quotes: quotes.map((q) => ({ ...q, readAt: q.readAt.toISOString(), countsTowardIndex: p.status === "live" && q.hour === hour && isLive(q, printedAt) })),
    series,
    chain,
  };
}

/** Write to a uniquely named temp file in the same directory, sync it, and rename, so a reader never sees a torn file. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * history.json first, then latest.json, then the page, so a reader who sees the new latest also sees its print in the history.
 * `latest` is null before the first print ever: the page says when the first print is due, history.json is empty,
 * and latest.json is removed (it 404s) rather than filled with a print that does not exist.
 */
export async function publishFiles(dir: string, latest: Latest | null, history: readonly Print[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const rows = history.map((p) => ({ ...publicPrint(p), hourStartUtc: hourStart(p.hour).toISOString(), printedAt: p.printedAt.toISOString() }));
  await writeAtomic(join(dir, "history.json"), JSON.stringify(rows, null, 0));
  if (latest) await writeAtomic(join(dir, "latest.json"), JSON.stringify(latest, null, 1));
  else await rm(join(dir, "latest.json"), { force: true });
  await writeAtomic(join(dir, "index.html"), renderPage(latest));
}
