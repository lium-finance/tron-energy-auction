import { MIN_LIVE } from "../core/print.js";
import type { Latest } from "./publish.js";

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const sun = (v: number | null): string => (v === null ? "none" : `${v.toFixed(2)} sun`);
const units = (n: number): string => n.toLocaleString("en-US");
/** An ISO UTC timestamp as `YYYY-MM-DD HH:MM:SS` (or `YYYY-MM-DD HH:MM` with `minutes`). */
const utc = (iso: string, minutes = false): string => iso.slice(0, minutes ? 16 : 19).replace("T", " ");

const CSS = `:root{color-scheme:light dark;--fg:#1b1b1b;--bg:#fff;--muted:#555;--line:#d4d4d4;--panel:#f4f4f4}@media (prefers-color-scheme:dark){:root{--fg:#ececec;--bg:#141414;--muted:#aaa;--line:#3a3a3a;--panel:#1f1f1f}}
*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:900px;color:var(--fg);background:var(--bg)}
h1{font-size:1.2rem;margin:0 0 .75rem}h2{font-size:1.05rem;margin:1.5rem 0 .25rem}
.headline{margin:0 0 .25rem;font-size:1.9rem;font-weight:600;line-height:1.2;overflow-wrap:anywhere}.headline.none{font-size:1.3rem}
.badge{display:inline-block;padding:.1rem .5rem;border:1px solid var(--muted);border-radius:.4rem;font-size:.9rem;font-weight:400;vertical-align:middle}
.meta,.note{color:var(--muted);font-size:.9rem;margin:.25rem 0}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:.4rem;margin:.5rem 0}.scroll:focus{outline:2px solid var(--muted)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}th{background:var(--panel)}
small.reason{display:block;white-space:normal;min-width:14rem;max-width:22rem;font-weight:400;color:var(--muted);font-size:.85rem}tr.dim td,tr.dim th{color:var(--muted)}tr:last-child td,tr:last-child th{border-bottom:0}`;

function nextHourUtc(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(11, 16);
}

/** The line every print carries, whatever its status: what was priced, for which hour, and when it was printed. */
function when(latest: Latest): string {
  return `${esc(units(latest.instrument.units))} units for 1 hour, ${esc(utc(latest.hourStartUtc, true))} UTC, printed ${esc(utc(latest.print.printedAt))} UTC`;
}

/** The headline block: a number only for a live print, never for no_index or thin, which publish no price. */
function headline(latest: Latest): string {
  const p = latest.print;
  if (p.status === "thin") {
    const n = p.liveCount;
    return `<p class="headline none">No price this hour: thin, ${esc(n)} live ${n === 1 ? "quote" : "quotes"} <span class="badge">THIN</span></p>
<p class="meta">${when(latest)}.</p>
<p class="meta">A price needs at least ${MIN_LIVE} live quotes for ${esc(units(latest.instrument.units))} units for one hour. No median is published. The ladder below lists what each venue answered; none of it is the index.</p>`;
  }
  if (p.status === "no_index") {
    const n = p.depthAwareCount;
    return `<p class="headline none">No index this hour: ${esc(n)} ${n === 1 ? "venue" : "venues"} can quote ${esc(units(latest.instrument.units))} units <span class="badge">NO INDEX</span></p>
<p class="meta">${when(latest)}.</p>
<p class="meta">An index needs at least ${MIN_LIVE} venues that can quote ${esc(units(latest.instrument.units))} units for one hour. No median is published. The ladder below lists what each venue answered; none of it is the index.</p>`;
  }
  const value = p.median === null ? "No median" : sun(p.median);
  return `<p class="headline">${esc(value)} <span class="badge">${esc(`LIVE, ${p.liveCount} live quotes`)}</span></p>
<p class="meta">${when(latest)}. Cheapest ${esc(sun(p.cheapest))}, dearest ${esc(sun(p.dearest))}.</p>`;
}

/** One static page rendered from the same JSON as the feed. No script, no external resource; every venue string is escaped. */
export function renderPage(latest: Latest | null): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tron energy index</title><style>${CSS}</style></head><body><main><h1>Tron energy reference price</h1>`;
  if (!latest) return `${head}<p>First print at ${esc(nextHourUtc())} UTC.</p></main></body></html>`;

  const rows = latest.quotes
    .filter((q) => q.term === "1h")
    .map(
      (q) =>
        `<tr${q.countsTowardIndex ? "" : ' class="dim"'}><th scope="row">${esc(q.venue)}${q.reason ? `<small class="reason">${esc(q.reason)}</small>` : ""}</th><td>${q.countsTowardIndex ? "Yes" : "No"}</td><td>${esc(q.sunPerUnit === null ? "none" : q.sunPerUnit.toFixed(2))}</td><td>${esc(q.status)}</td><td>${esc(units(q.size))}</td><td>${esc(q.depth === null ? "unknown" : units(q.depth))}</td><td>${esc(utc(q.readAt))}</td></tr>`,
    )
    .join("");
  const ladder = `<h2>Per-venue ladder</h2>
<p class="note">Sun per energy unit for a 1-hour term, as each venue answered this hour. "Counts toward index" is Yes only for a live quote for ${esc(units(latest.instrument.units))} units with depth that covers it; a price quoted for a smaller package or with unknown depth is shown for reference and is No. On a thin hour or an hour with no index nothing counts, because no price is published.</p>
<div class="scroll" role="region" aria-label="Per-venue ladder, scrolls sideways" tabindex="0"><table><thead><tr><th scope="col">Venue</th><th scope="col">Counts toward index</th><th scope="col">Sun per unit</th><th scope="col">Status</th><th scope="col">Size asked (units)</th><th scope="col">Depth (units)</th><th scope="col">Read (UTC)</th></tr></thead><tbody>${rows || `<tr><td colspan="7">No quotes stored for this hour.</td></tr>`}</tbody></table></div>`;

  const series = (["1d", "7d", "14d"] as const)
    .map((t) => `<tr><th scope="row">${t}</th><td>${latest.series[t].map((s) => `${esc(s.venue)} ${esc(s.sunPerUnitDay.toFixed(2))}`).join(", ") || "none"}</td></tr>`)
    .join("");

  return `${head}
${headline(latest)}
${ladder}
<h2>Term series (sun per unit per day)</h2>
<div class="scroll" role="region" aria-label="Term series, scrolls sideways" tabindex="0"><table><thead><tr><th scope="col">Term</th><th scope="col">Venues</th></tr></thead><tbody>${series}</tbody></table></div>
<h2>Method</h2><p>${esc(latest.method)} Method version ${esc(latest.methodVersion)}.${latest.chain ? ` Energy burn price ${esc(latest.chain.energyFeeSun)} sun per unit.` : ""} Feed: <a href="latest.json">latest.json</a>, <a href="history.json">history.json</a>.</p>
</main></body></html>`;
}
