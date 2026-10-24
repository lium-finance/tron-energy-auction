# Tron energy index

[![ci](https://github.com/lium-finance/tron-energy-auction/actions/workflows/ci.yml/badge.svg)](https://github.com/lium-finance/tron-energy-auction/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)

An open, auditable hourly reference price for Tron energy, and the scripts that test whether an auction for energy
could work.

On Tron, every smart-contract call burns **energy**. Holders who stake TRX receive an energy allowance that resets
daily, and a market of rental venues resells it. Each venue quotes in its own units, sizes and terms, and many quotes
cannot actually be filled at size. There is no neutral price. This repository builds one:

- **The index.** Every hour it asks the energy venues and the chain what **20,000,000 energy units for one hour** cost,
  stores every answer (failures included), computes the median of the quotes that can really fill that size by a
  published rule, and publishes `latest.json`, `history.json` and a static page.
- **The four fact scripts.** Supplier, utilisation, band and clearability: measurable conditions that an hourly,
  sealed-bid, uniform-price auction for energy would depend on, computed from the same stored data.

Built by [LIUM Finance](https://lium.finance). The research behind it is the post
["An auction for Tron energy"](https://research.lium.finance) on research.lium.finance.

## Contents

- [How the price is made](#how-the-price-is-made)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Status and roadmap](#status-and-roadmap)
- [Contributing](#contributing)
- [License](#license)

## How the price is made

| Rule | Value |
| --- | --- |
| Instrument | 20,000,000 energy units, delegated for 1 hour, in sun per unit |
| Live quote | status `ok`, depth of at least 20,000,000 units, read less than 60 minutes before the print |
| Price | the median of live quotes, one per venue (the latest) |
| No price | fewer than 3 venues able to fill the size (`no_index`), or fewer than 3 live quotes (`thin`) |
| Sanity band | a quote below 1 sun or above the chain's energy fee for the hour is `rejected` and kept with its raw value |
| Corrections | none: prints are immutable, missing hours are never backfilled |

Venues asked today: TronSave, TronBid, GetBlock, NetTS, JustLend (daily series), plus TronGrid for the chain and
CoinGecko for the TRX price. Only TronSave currently answers a size for the 1-hour instrument, so most hours print
`no_index` with the full per-venue ladder published. That is a finding, not a bug: see
[docs/methodology.md](docs/methodology.md#why-most-hours-print-no_index-today).

## Quick start

Requirements: Node 24 (`.nvmrc`), npm, and Postgres 16 for the service and the database tests.

```sh
git clone https://github.com/lium-finance/tron-energy-auction.git
cd tron-energy-auction
npm ci
npm run typecheck && npm test
```

Without `TEST_DATABASE_URL` the Postgres tests are skipped. To run them, point it at a database whose name contains
`test` (the tests truncate tables):

```sh
docker run -d --name tei-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=index_test -p 5432:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/index_test npm test
```

Ask every venue once, live, without storing anything:

```sh
cp .env.example .env        # add a TronGrid API key
npm run smoke
```

Run the service locally:

```sh
export DATABASE_URL=postgres://postgres:test@localhost:5432/index_test TRONGRID_API_KEY=... PUBLISH=on HEALTHCHECK_PING_URL=https://hc-ping.com/<your-check>
npm run migrate
npm run dev                 # http://localhost:3000
```

`npm run dev` does not read `.env`; export the variables in the shell. The scripts do read `.env`.

## Configuration

Secret values are never logged: every log line, stored reason and alert is redacted against them.

| Variable | Required | Secret | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | yes | Postgres connection string. |
| `TRONGRID_API_KEY` | yes | yes | TronGrid key for chain and wallet reads. |
| `PUBLISH` | no (`off`) | no | `on` writes the public files; `off` collects and prints only. |
| `HEALTHCHECK_PING_URL` | with `PUBLISH=on` | yes | Dead-man monitor URL (https), pinged after each print. |
| `ALERT_WEBHOOK_URL` | no | yes | Webhook (https) for degraded-data and thin-share alerts. Unset: stderr. |
| `PUBLIC_DIR` | no (`public`) | no | Where the public files are written and served from. |
| `PORT` | no (`3000`) | no | HTTP port. |
| `NETTS_API_KEY` | no | yes | NetTS key. Not used until a keyed response is recorded and parsed. |
| `VERIFY_WALLETS_FILE` | for the supplier and utilisation facts | the file is private | Wallets to read hourly. Shape: [docs/verification/wallets.example.json](docs/verification/wallets.example.json). Never commit the real file. |
| `VERIFY_RPS` | no (`2`) | no | TronGrid requests a second for wallet reads, 1 to 10. |
| `ENV_FILE` | no | no | For scripts: a `.env` file to load instead of the one at the root. |
| `NILE_PRIVATE_KEY`, `NILE_RECEIVER`, `NILE_PROBE_ADDRESS`, `NILE_AMOUNT_TRX` | for `nile-probe` only | the key is | Nile testnet probe settings. Use a throwaway wallet. |

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over sources and tests. |
| `npm test` | The vitest suite. |
| `npm run build` | Compiles `src` to `dist`. |
| `npm run migrate` | Applies pending SQL migrations to `DATABASE_URL`. |
| `npm start` | Runs the built service. In production run `node dist/index/main.js` directly so node receives SIGTERM. |
| `npm run dev` | Runs the service from source. |
| `npm run collect-once` | Runs and prints the current hour once, like the service, without pinging the monitor. |
| `npm run smoke` | Asks every collector once against the live APIs. Stores nothing. |
| `npm run verify-supplier` | Supplier fact from stored wallet reads. |
| `npm run verify-utilisation` | Utilisation fact from stored wallet reads. |
| `npm run build-top100` | Builds the top-100 energy staker list from Tronscan and TronGrid. |
| `npm run verify-band` | Band fact and term premium from stored quotes. |
| `npm run verify-clearability` | Paper clearing of one supplier against two and three bidders. |
| `npm run export-decision` | Writes a dated decision record under `docs/decisions/<date>/`. |
| `npm run nile-probe` | One step of the locked-delegation check on the Nile testnet. |

Every fact script prints one JSON line.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/core` | Pure rules, no I/O: the print rule, normalization, clearing, pass conditions, hour math. |
| `src/collectors` | One adapter per venue and the chain reader, all through one HTTP helper. |
| `src/index` | The service: config, database, hour job, schedule, publishing, page, server, alerts, redaction. |
| `src/scripts` | Command-line scripts. |
| `migrations` | SQL migrations, applied in order under an advisory lock. |
| `contracts/probe` | A small Solidity contract used only by the Nile probe. |
| `test` | Vitest tests mirroring `src`, with recorded venue responses in `test/fixtures`. |
| `docs` | Methodology, architecture, runbook and verification records. |

## Documentation

- [Methodology](docs/methodology.md): the instrument, the print rule, what is published, the four facts.
- [Architecture](docs/architecture.md): modules, the hour, design choices, data model.
- [Runbook](docs/runbook.md): deploying (Railway as the worked example), expected logs, incidents.
- [Verification records](docs/verification/): venue API checks, the top-100 source, the Nile lock probe.

## Status and roadmap

Version 0.1: the index and the four fact scripts are complete and tested. Not yet built:

- the auction itself (contracts on the TVM, a keeper, an agent-facing API), which waits on the facts;
- a clearing simulator that replays real hours through the corrected clearing rule;
- collectors for venues that quote a headline price without depth (iTRX, TronZap, TokenGoodies, TRON Energy Market,
  TronPulse).

Proposals are welcome as issues.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). A venue that changed its API, or a new venue that quotes size, is the most
useful contribution. Please report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Gnosis EasyAuction and Term Finance are design references for the auction; no code is copied from
either.
