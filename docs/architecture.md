# Architecture

One Node 24 package, one `package.json`, one `tsconfig.json`, one vitest suite. The folders under `src/` are modules,
not workspaces.

```
                         ┌──────────────── src/collectors ────────────────┐
  :00 tick ──► hour job ─┤ tronsave · tronbid · getblock · netts          ├──► http.ts (budget, retry, size cap)
  (src/index/hour.ts)    │ justlend · coingecko · chain (TronGrid)        │       │
        │                └───────────────────────────────────────────────┘       ▼
        │                                                                     venue and chain APIs
        ▼
   Postgres: quotes · payloads · prints · chain · verification · alerts
        │
        ├──► print()             src/core/print.ts   (pure: the print rule)
        ├──► publish             src/index/publish.ts → public/latest.json, history.json, index.html
        ├──► dead-man ping       HEALTHCHECK_PING_URL
        └──► :05 alert job       src/index/alert.ts  → ALERT_WEBHOOK_URL or stderr

  src/index/serve.ts   read-only node:http server: /, /index.html, /latest.json, /history.json, /healthz
  src/scripts/*        one-off and fact scripts over the same database
```

## Modules

| Folder | Responsibility | May import |
| --- | --- | --- |
| `src/core` | Pure rules with no I/O: types and constants, normalization to sun per unit, the print rule, clearing, the pass conditions, hour arithmetic, statistics. | nothing outside `src/core` |
| `src/collectors` | One adapter per venue plus the chain reader. Each returns a typed `Quote` (or a typed failure) and never throws for an upstream problem. All HTTP goes through `http.ts`; CI fails if a collector calls `fetch` directly. | `src/core` |
| `src/index` | The running service: configuration, Postgres access and migrations, the hour job, scheduling, publishing, the page, the HTTP server, alerts, secret redaction, and the entry point `main.ts`. | `src/core`, `src/collectors` |
| `src/scripts` | Command-line entry points: `collect-once`, `smoke`, the four fact scripts, `build-top100`, `export-decision`, `nile-probe`. | everything |

`test/layering.test.ts` enforces the import rules.

## The hour

1. The job fixes its target hour when it starts (the `:00` tick's hour, or the current hour at start-up if it has no
   print yet) and stamps every quote with it.
2. All collectors run in parallel, 20 seconds each. Every result and every failure is inserted into `quotes`. Raw
   bodies go to `payloads`, keyed by their sha256, and are deleted after 30 days.
3. The print is computed from the stored quotes and inserted with `on conflict (hour) do nothing`. If another process
   printed first, this run stops: only one print per hour can exist.
4. With `PUBLISH=on`, the three public files are rewritten (temporary file, then rename).
5. The run that inserted the print pings the dead-man monitor, unless every published venue failed or is missing. A collect-only venue does not count.
6. If a wallets file is configured, the supplier and top-100 wallets are read into `verification`. These rows are never
   published.

On start-up the service applies migrations under a Postgres advisory lock, starts the HTTP server, republishes the files
from the last stored print (a platform disk may be wiped on deploy), then runs the current hour if it has no print.

## Design choices

- **Store everything, publish a rule.** Every venue answer, including failures and their reasons, is a row. The
  published number is a deterministic function of those rows, so any print can be recomputed and audited.
- **Idempotent by key.** `prints(hour)` and `quotes(hour, venue, size, term)` are unique. Two processes running the same
  hour cannot produce two prints.
- **No backfill.** A missed hour stays missing. Prices are never extrapolated.
- **Secrets never leave redacted.** Every log line, stored reason and alert passes through `redactSecrets`
  (`src/index/redact.ts`): URLs are cut to scheme and host, and the value of every secret-named variable is replaced.
- **Static output.** The feed is files, not a query API, so it can sit behind any CDN.
- **One replica.** The service is designed to run as a single process. A second one is harmless (see above) but wasteful.

## Data model

`migrations/001-initial.sql` is the source of truth. In short:

| Table | One row per |
| --- | --- |
| `quotes` | venue answer: hour, venue, size, term, sun per unit, depth, read time, source, status, reason, payload hash |
| `payloads` | raw response body, by hash (30-day retention) |
| `prints` | hour: median, cheapest, dearest, live count, depth-aware count, status, method version, print time |
| `chain` | hour: energy fee in sun, total energy weight and limit, TRX price in USD |
| `verification` | wallet read: hour, wallet, energy limit, energy used (never published) |
| `alerts` | alert kind sent per UTC day (deduplication) |
