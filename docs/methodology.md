# Methodology

Method version `2026-10-23.1` (`METHOD_VERSION` in `src/core/types.ts`). Every print stores the method version it was
computed under, so a change to any rule below ships with a new version and never rewrites old prints.

## The instrument

One instrument is priced: **20,000,000 energy units, delegated to an activated wallet, for one hour**, quoted in
**sun per unit** (1 TRX = 1,000,000 sun). The constants are `INSTRUMENT`, `SUN_PER_TRX` and `TRANSFER_UNITS` in
`src/core/types.ts`.

## Collection

At `:00` every hour the index asks each venue for a quote at three sizes (5, 20 and 50 million units) where the venue's
API takes a size, and reads the chain for the hour's energy fee and `TotalEnergyWeight`. Every answer is stored as a row
in `quotes`, failures included, with a status and a reason:

| Status | Meaning |
| --- | --- |
| `ok` | A parsed quote. |
| `no-depth` | The venue answered but cannot fill the requested size. An empty order book is `no-depth` with no price. |
| `depth-unknown` | The venue publishes a price but no size it can fill (a package catalog or a page tier). It is shown, never counted. |
| `rejected` | The price fell outside the sanity band (below 1 sun, or above the hour's energy fee from the chain). The raw value is kept. |
| `failed` | Timeout, HTTP error, rate limit, or a response that no longer matches the parser. The reason says which. |
| `missing` | The venue was not asked this hour. Today this is NetTS: no keyed response has been recorded yet, so it has no parser and is never asked. |

Every request goes through one helper (`src/collectors/http.ts`) with a 20 second budget, one retry on timeout, one
backoff on HTTP 429 inside the budget, and a size cap on the body. Prices quoted in TRX or USDT per transfer are
normalized to sun per unit (`src/core/normalise.ts`), using 65,000 units per transfer and, for USDT, a TRX price read in
the same minute.

Quotes are unique on `(hour, venue, size, term)` and inserted first-writer-wins, so two runs of the same hour store one
set of rows.

## The print rule

The print is computed from the stored quotes for the target hour (`print()` in `src/core/print.ts`):

1. **Candidates:** quotes for the instrument's size and the 1-hour term, stamped with the target hour. When a venue has
   more than one, its latest answer wins, whatever its status.
2. **Depth-aware:** the venue reports depth of at least 20,000,000 units.
3. **Live:** depth-aware, status `ok`, a positive finite price, read less than 60 minutes before the print.
4. **Outcome:**
   - fewer than three depth-aware venues: `no_index`, no median is published;
   - three or more depth-aware venues but fewer than three live quotes: `thin`, no price is published;
   - otherwise: `live`, and the published price is the **median** of the live quotes (the mean of the two middle values
     for an even count), with the cheapest and dearest beside it.

Median, cheapest and dearest are rounded to four decimals. A print is never changed after it is written, and a missed
hour stays missing: prices are never backfilled or extrapolated.

### Why most hours print `no_index` today

At the time of writing only TronSave answers a size for the 1-hour instrument among the published venues. TronBid's
public catalog tops out at about 1,048,000 units, GetBlock's page tiers at 540,000, and NetTS needs a key and caps an
order at 3,000,000 (`docs/verification/venue-apis.md`). TronPulse's keyless rate is its 1-hour minimum buy price,
without depth, so it is `depth-unknown` (`docs/verification/venue-apis-2026-10-28.md`). JustLend's minimum rental is three hours, so it cannot quote the
instrument; its daily rate is published as a separate series. The rule is kept as written rather than lowered to fit
the venues: the feed publishes the full per-venue ladder with the `no_index` flag, so the gap is visible.

### Collect-only venues

iTRX, TRON Energy Market and TokenGoodies answer a price with depth (platform availability, a pool ladder, an open
buy-order book), and TronZap a `depth-unknown` price for one 65,000-unit transfer, but their terms restrict automated
reads or reproducing their data. They are asked every hour and
their quotes are stored, but the print is computed without them, `latest.json` and the page leave them out, and the
band and clearability facts ignore them, until the venue's `PUBLISH_ITRX`, `PUBLISH_TRONENERGY_MARKET`,
`PUBLISH_TRONZAP` or `PUBLISH_TOKENGOODIES` is `on` (`src/index/gate.ts`). Turning one on changes which venues the print can count from
that hour on; stored prints are not recomputed.

## What is published

Three static files, rewritten after each print (written to a temporary file, then renamed, so a reader never sees a
partial file), and served read-only by `src/index/serve.ts`:

| Path | Contents |
| --- | --- |
| `/latest.json` | The latest print, every quote of that hour (except collect-only venues') with its status and reason, the 1-day series, the chain fields, and the method version. |
| `/history.json` | Every print. |
| `/` or `/index.html` | A page rendered from the same data: the print, the venue ladder, the method in five sentences, and the longer-term series. |
| `/healthz` | `ok` while the process is up. |

On a `thin` or `no_index` hour the feed and the page carry no median, cheapest or dearest. The stored print keeps the
raw values for audit.

## The four facts

The scripts in `src/scripts` answer four questions an auction for Tron energy would depend on. Each pass condition is a
pure, unit-tested function in `src/core/pass.ts`.

| Fact | Script | Pass condition |
| --- | --- | --- |
| Supplier | `verify-supplier` | The supplier's own wallets average at least 200,000,000 idle energy units a day (mean allowance minus energy burned, over 24 hours of hourly reads). |
| Utilisation | `verify-utilisation` | The top-100 energy stakers use at least 85 % of the energy they keep (`EnergyUsed / EnergyLimit`). Below 70 % suggests a markup market instead. Energy they delegate out is not counted, so the figure is a lower bound. |
| Band | `verify-band` | In at least 12 of 24 hours, the cheapest quote with full depth is at least 5 sun above JustLend's daily rate net of its reserve factor. A term premium is reported when a 7- or 14-day price per unit-day exceeds the 1-day price by 10 % or more. |
| Clearability | `verify-clearability` | A corrected uniform-price clearing rule (`clearCorrected` in `src/core/clear.ts`) gives a positive clearing price for one supplier against two and three bidders inside the band. |

Energy burned per hour is reconstructed from hourly deltas of the chain's decaying `EnergyUsed` total
(`used_t - used_prev x (1 - gap/24)`, clamped at zero). A wallet counts only with 24 hours of reads and at most two
unread hours. Results within about 2 % of a threshold are reported as marginal.

`export-decision` writes the facts, the prints and the band into a dated record under `docs/decisions/<date>/`
(`prints.csv`, `band.csv`, `facts.json`, `decision.md`).

## Alerts

- **Dead-man ping:** after each print, one GET to `HEALTHCHECK_PING_URL`, so an outside monitor alerts when prints stop.
  The ping is withheld when every venue failed, so a total collector outage also trips the monitor.
- **Degraded data** (at `:05`, once per UTC day): the two latest prints both had no venue able to fill the instrument,
  no 1-hour quote other than failed or missing, or no chain read.
- **Thin share** (at `:05`, once per UTC day): more than 10 % of the last 24 prints are `thin`.
