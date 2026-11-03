# Runbook: running the Tron energy index

This runbook uses [Railway](https://railway.com) as the worked example. Any host works if it gives you Node 24, one
Postgres database, a single long-running process that receives SIGTERM directly, and a healthcheck on `/healthz`;
the settings table below lists what each Railway setting is for, so you can map it to your platform.

One Railway project: a Postgres database and one service built from this repository. The service runs
`node dist/index/main.js`: migrations, then the HTTP server (always, so `GET /healthz` answers `ok` from the start),
then the current hour once, then the `:00` hour job and the `:05` alert job. The job's log lines are
`<ISO time> <text>` on stdout. Three kinds go to stderr with no timestamp: `[alert] ...` lines, `serve: ...` lines, and
the error that stops start-up (for example `ConfigError: ...`). The texts quoted below are copied from the source
(`src/index/main.ts`, `hour.ts`, `wire.ts`, `alert.ts`, `schedule.ts`, `serve.ts`).

Railway documentation was read on 2026-10-23. Links are given where a step depends on it.

## Platform settings (railway.json is not read by a new service)

[Config as Code](https://docs.railway.com/config-as-code) (`railway.json`) is deprecated. The page says: "New services
cannot opt into Config as Code", and existing files stop being read on 2026-12-01. Its replacement is
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) (`.railway/railway.ts`, applied with the
Railway CLI). This repository has no IaC file yet.

`railway.json` is kept as the checked record of the settings the service needs (`test/railway.test.ts` checks it
against the code). A new service gets them from its settings page or from documented service variables:

| Setting | Value | Where on a new service |
| --- | --- | --- |
| Builder | Railpack | the default for new services ([reference](https://docs.railway.com/config-as-code/reference#specify-the-builder)) |
| Node | 24 | variable `RAILPACK_NODE_VERSION=24`; Railpack would also read `engines.node` (`>=24 <25`) from package.json ([Railpack Node](https://railpack.com/languages/node)) |
| Build | `npm run build` | Railpack installs the dependencies with npm and runs the `build` script ([Railpack Node](https://railpack.com/languages/node)) |
| Start | `node dist/index/main.js` | service Settings, Custom Start Command ([start command](https://docs.railway.com/builds/build-and-start-commands#start-command)), or variable `RAILPACK_START_CMD` ([Railpack variables](https://railpack.com/config/environment-variables)). Not the detected `npm start`: node itself must receive SIGTERM. Through npm and a shell, the 40 s draining and the 30 s shutdown bound are not guaranteed |
| Healthcheck path | `/healthz` | service Settings ([healthchecks](https://docs.railway.com/deployments/healthchecks)) |
| Healthcheck timeout | 60 s | variable `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=60` ([variables](https://docs.railway.com/variables/reference#user-provided-configuration-variables)) |
| Draining | 40 s | variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=40` (default 0) |
| Overlap | 0 s | variable `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0` (already the default) |
| Restart policy | On Failure, 10 retries | the default ([restart policy](https://docs.railway.com/deployments/restart-policy)) |
| Replicas | 1 | the default ([scaling](https://docs.railway.com/deployments/scaling)) |
| Serverless (app sleeping) | off | Settings > Deploy > Serverless, off unless toggled ([cost control](https://docs.railway.com/pricing/cost-control#enabling-serverless)) |

Why these values:

- Draining 40 s: a SIGTERM shutdown takes at most 30 s (the server close, forced after 5 s; up to 20 s for a running
  hour, `SHUTDOWN_WAIT_MS`; then 5 s to close the database). Draining is the time between SIGTERM and SIGKILL.
- Overlap 0 and one replica: two processes must never both run the hour job. If they do anyway, nothing is printed
  twice: `insertPrint` inserts with `on conflict (hour) do nothing`, the losing run logs
  `hour <h>: another run printed first; stopping`, and only the run that inserted the print pings the dead-man monitor.
  Quotes also insert first-writer-wins, and the print is computed from the stored quotes, so it is reproducible.
- Serverless off: the service is idle for most of each hour, and a slept service would miss the `:00` tick.

Moving to IaC (`railway config migrate`, then `railway config plan`) is a decision for whoever owns the Railway
project; the IaC reference documents build, start, healthcheck, healthcheck timeout and replicas, but not draining,
overlap, restart policy or Serverless, so those stay as variables or settings.

## First deploy: collect only, with PUBLISH=off

Done by a person in the Railway dashboard:

1. Create a project. Add a Postgres database.
2. Add a service from your fork or clone of `lium-finance/tron-energy-auction`.
3. Create a check on healthchecks.io with a 60-minute period and a 2-hour grace, and copy its ping URL. The dead-man
   ping runs from the first deploy, in collect-only mode too: after each print, and withheld when every published venue failed
   or is missing, so a dead process, or an outage of the venues that feed the print, is noticed before anything is published.
   A venue whose PUBLISH_* flag is off does not keep the ping alive.
4. Put the wallets file on a volume, as in [Verification reads](#verification-reads-supplier-and-top-100-wallets),
   option (a), if you run the supplier and utilisation reads: create a volume, attach it at `/data`, and upload `docs/verification/wallets.json` (and its `top100File`,
   if it names one) with the Railway CLI. The supplier and utilisation facts need 24 hours of wallet reads, so start the
   reads with the first deploy.
5. Set the service variables (the reference syntax is `${{SERVICE_NAME.VAR}}`,
   [variables](https://docs.railway.com/variables); use the Postgres service's name as shown on the canvas):

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   TRONGRID_API_KEY=<the TronGrid key>
   PUBLISH=off
   HEALTHCHECK_PING_URL=<the check's ping URL, from step 3>
   VERIFY_WALLETS_FILE=/data/wallets.json
   NETTS_API_KEY=<optional>
   RAILPACK_NODE_VERSION=24
   RAILWAY_HEALTHCHECK_TIMEOUT_SEC=60
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=40
   RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0
   ```

   `PORT` is set by Railway; the server listens on it. `PUBLIC_DIR` defaults to `public`.
6. In the service settings, set the Custom Start Command to `node dist/index/main.js` (or set the variable
   `RAILPACK_START_CMD=node dist/index/main.js`), so node itself receives SIGTERM rather than npm or a shell. Set the
   healthcheck path to `/healthz`, and check that Serverless is off.
7. Deploy.
8. Check the first build log: the Node version Railpack installs must be 24.x.
9. Check the first print: the healthchecks.io check shows its first ping, the start-up log has no
   `start: verification reads disabled: ...` line, and the hour logs `hour <h>: verification reads <n> ok, <n> failed`
   with `<n> ok` above zero.
10. Check the first restart (Restart the deployment once, after the first print): the logs must show the real shutdown
   sequence, in this order, in the restarted deployment's logs (for a redeploy, in the old deployment's logs):

   ```
   shutdown: SIGTERM received; stopping the ticks
   shutdown: closing the server
   shutdown: server closed
   shutdown: waiting up to 20 s for running jobs
   shutdown: no job running
   shutdown: closing the database
   shutdown: database closed
   shutdown: done
   ```

   (`shutdown: a job is still running after 20 s; closing the database under it` in place of `no job running` if an
   hour was running.) If these lines are missing, the signal did not reach node: fix the start command.

Healthy in the first minute (one line each, in this order; `<n>` is Railway's port):

```
start: publish=off port=<n>
start: migrations applied 001-initial.sql
start: venues=6
start: serving public on :<n> (healthz only until PUBLISH=on)
```

With `HEALTHCHECK_PING_URL` unset (allowed while `PUBLISH=off`), one more line says the monitor is not watching:
`start: outside dead-man ping off: HEALTHCHECK_PING_URL is not set`. Set it (step 5) before leaving the service to run.

On later deploys the second line is `start: migrations none pending`. Then the current hour runs once: one line per
quote, `hour <h>: <venue> <size> <term> <status>` (with ` (<reason>)` when there is one), and then

```
hour <h>: printed <status> median=<m> live=<n> depthAware=<n>
```

Almost every print is `no_index` by design: only TronSave can quote the instrument with depth
(docs/verification/venue-apis.md).

Healthy in the first hour: at each `:00`, the quote lines and one `hour <h>: printed ...` line; at each `:05`,

```
alerts: thin share <p> %
alerts: degraded none
```

Without `ALERT_WEBHOOK_URL`, an alert is still written to stderr as `[alert] <text>`; set the webhook at the first deploy if
anyone should hear about degraded data before publishing starts.

## Verification reads (supplier and top-100 wallets)

The hour job reads the listed wallets after each print when `VERIFY_WALLETS_FILE` names a wallets file
(`docs/verification/wallets.example.json` shows the shape). The real file, `docs/verification/wallets.json`, names the
supplier's wallets, is gitignored and is never in a build. The supplier's addresses must never go into git, into
a platform variable or into anything that is logged. The index logs wallets by list label (`supplier[0]`, `top100[3]`),
never by address.

`VERIFY_RPS` sets TronGrid requests a second for these reads: a whole number from 1 to 10, default 2 (unauthenticated
TronGrid allows 3 a second, `src/collectors/pace.ts`). A bad value or a bad file turns off only the reads, at start-up:

```
start: verification reads disabled: <error>
```

and each printed hour then says `hour <h>: verification reads disabled (see start-up log)`. Working reads log
`hour <h>: verification reads <n> ok, <n> failed` after the print.

Recommended: (a), a Railway volume, set up in the first deploy, step 4.

(a) A volume holding the file. Create a volume and attach it to the service with a mount path such as `/data`
([volumes](https://docs.railway.com/volumes)). Put the file on it with the Railway CLI
([railway volume](https://docs.railway.com/cli/volume)). First link the directory to the project, environment and
service ([railway link](https://docs.railway.com/cli/link)); `--volume <name>` (before the subcommand) picks the volume
when there are several, and `--overwrite` replaces the file on a later upload:

```bash
railway link
railway volume files --volume <name> upload ./docs/verification/wallets.json /wallets.json
railway volume files --volume <name> list /
```

To replace the file later:

```bash
railway volume files --volume <name> upload --overwrite ./docs/verification/wallets.json /wallets.json
```

If `wallets.json` names a `top100File`, that path is
resolved against the wallets file's directory, so upload it beside it. Set `VERIFY_WALLETS_FILE=/data/wallets.json`
and restart: the file is read once, at start-up.

Confirmation step: the docs do not say how an upload's remote path maps onto the mount path, so the start-up log is
the proof. It must have no `start: verification reads disabled: ...` line, and the first printed hour must log
`hour <h>: verification reads <n> ok, <n> failed` with `<n> ok` above zero. A volume also stops two deployments from being active at once
([healthchecks](https://docs.railway.com/deployments/healthchecks#services-with-attached-volumes)), at the cost of a
short gap on each redeploy.

(b) A laptop process against the Railway database: `npm run dev` locally, with `VERIFY_WALLETS_FILE` and the
database's public URL. Use it only if a volume is not possible. It has three costs:

- Postgres Public Access stays on, with a live password, for the whole window it runs; at the end, turn Public Access
  off and regenerate the password (as in the decision record section, step 4).
- It is a second hour job writing quotes and prints into the production record, and it can win hours: whichever
  process inserts an hour's print first owns it, and that print is computed from the quotes stored first. It reads
  wallets only in the hours it wins, so its coverage is a race with Railway.
- `npm run dev` (`tsx src/index/main.ts`) does not load `.env`: unlike the scripts, main.ts never calls `loadDotEnv`.
  Every variable must be exported in the shell, the database URL without echoing it:

  ```bash
  read -rs DATABASE_URL && export DATABASE_URL
  export TRONGRID_API_KEY=... PUBLISH=off VERIFY_WALLETS_FILE=docs/verification/wallets.json
  npm run dev
  ```

  Do not export `HEALTHCHECK_PING_URL` for this process: it would ping the check and tell the monitor the deployed
  service is alive when it may not be.

## Switch publishing on

The ping URL and the wallets file have been set since the first deploy. Set:

```
PUBLISH=on
ALERT_WEBHOOK_URL=<optional, an https webhook>
```

The process refuses to start with `PUBLISH=on` and no ping URL (exit 2, `ConfigError: HEALTHCHECK_PING_URL is required when PUBLISH=on`).
Deploy the change. Expected:

```
start: publish=on port=<n>
start: migrations none pending
start: venues=6
start: republished hour <h>
start: serving public on :<n>
```

(`start: no print yet; wrote the first-print page` instead of `republished` when the database has no print.) From now on
the ping is sent only after a successful publish. A public domain is a person's step: service Settings > Networking >
Generate Domain ([public networking](https://docs.railway.com/networking/public-networking)). The page is at the
domain root, and the server answers exactly these paths: `/`, `/index.html`, `/latest.json`, `/history.json`,
`/healthz`.

```bash
curl -fsS https://<domain>/healthz
curl -fsS https://<domain>/latest.json
curl -fsS https://<domain>/history.json
```

## After every deploy

1. The deployment turns active only after Railway's healthcheck got a 2xx from `/healthz`. With a domain:

   ```bash
   curl -fsS https://<domain>/healthz
   ```

2. Run the smoke script from a laptop, with `TRONGRID_API_KEY` (and optionally `NETTS_API_KEY`) in `.env`:

   ```bash
   npm run smoke
   ```

   It calls every collector once against the live venue and chain APIs, prints one line per quote, the chain and
   CoinGecko results and a `summary:` line, and stores nothing. It does not talk to the deployed service: it tells
   whether the APIs the service depends on answer right now. It exits 1 only when the chain read failed and no venue
   answered.

3. Read the start-up lines and the next `hour <h>: printed ...` line in the deploy logs.

## Incidents

Prices are never backfilled. A missed or failed hour stays missing or failed; the next tick runs the current hour.

### A venue row failed (schema)

- Symptom: a quote line `hour <h>: <venue> <size> <term> failed (schema: <what>)`.
- Cause: the venue changed its response.
- Action: save the new body as a fixture under `test/fixtures/`, fix the parser in `src/collectors/<venue>.ts`, add the
  fixture to its test, deploy.

### TronGrid 403 or 429

- Symptom: `hour <h>: chain read failed: <reason>; using the energy fee stored for hour <h'> (<fee> sun)` (or `the seed
  energy fee`). The reason names the call and the kind, for example `getchainparameters upstream: 403: ...` or
  `getaccountresource rate-limited: 429 twice`. TronGrid also answers rate limits as HTTP 200 with an `{"Error": ...}`
  body; the index reads that as a failure, `upstream error: <TronGrid's text>`, never as data.
- What the index does: one retry after a 429 inside the request budget; a failed chain read leaves no chain row for the
  hour, and the venues are still collected and printed with the last stored energy fee as the ceiling. Wallet reads
  retry once after 2 s on a rate limit (`verification <label>: rate limited; retrying once in 2 s`); a read that still
  fails is skipped, and that wallet's hour stays missing.
- Action: check the key and its plan on TronGrid; lower `VERIFY_RPS` if wallet reads are rate limited. Two hours in a
  row without a chain row raise the degraded alert.

### The dead-man ping stops

- Symptom: healthchecks.io alerts. In the logs: `[ping] monitor returned <status>` or `[ping] failed: <error>`, then
  `hour <h>: dead-man ping failed (the monitor will alert if this persists)`; or `hour <h>: ping withheld: every published venue failed`;
  or no `printed` line at all.
- Cause: the monitor is unreachable, every published venue failed (the ping is withheld on purpose; a collect-only venue does not count), a publish failed
  (with `PUBLISH=on`: `hour <h>: publish failed: ...`; no ping after a failed publish), or the process is not running the hour.
- Action: read the logs for the hours since the last ping. If the process is down or stuck, see below.

### Degraded data or the thin-share alert

At `:05`, through `ALERT_WEBHOOK_URL`, and always as `[alert] <text>` on stderr. A delivered alert is not sent again that
UTC day for the same kind. An alert that is not delivered (no `ALERT_WEBHOOK_URL`, or the webhook failed) releases its
claim, so the `[alert]` line repeats at every `:05` while the condition holds:

```
Tron energy index: the data is degraded in hours <h1> (<UTC hour>Z) and <h2> (<UTC hour>Z): <reasons>.
```

with one or more of `no venue could fill the instrument (TronSave down, or its depth below 20,000,000 units)`,
`every 1h quote failed or is missing`, `no chain read (energy fee and weight unknown)`; it fires when a condition holds in
the two latest consecutive prints. And:

```
Tron energy index: <n> of the last 24 prints are thin (<p> %).
```

when more than 10 % of the last 24 prints are `thin`. Action: read the quote lines of the hours named; fix the venue
or the key as above. A webhook that fails logs `[alert] webhook returned <status>; the alert above was not delivered`
and the next `:05` retries.

### Postgres down

- Symptom: `hour (start-up) failed: <error>` or `tick :00 failed: <error>`; `alerts: thin-share check failed: <error>`
  and `alerts: degraded check failed: <error>`, then `tick :05 failed: Error: alert checks failed: thin-share, degraded`.
  At start-up, a database it cannot reach ends the process (exit 1) and Railway restarts it (On Failure, 10 retries).
- Action: check the Postgres service in Railway. The ticks keep running; the first hour after the database is back
  prints. The hours in between are not backfilled.

### A stuck process

- Symptom: `tick :00 still running after 900 s; moving on, it keeps running`, or no `printed` line for more than an hour
  while the deployment shows active.
- Action: restart the deployment. Shutdown logs `shutdown: SIGTERM received; stopping the ticks` through
  `shutdown: done`. A restart inside an hour that is already printed logs `hour <h>: already printed; nothing to collect`.

## The decision record

Turn on Public Access for Postgres (its Settings > Networking), which fills `DATABASE_PUBLIC_URL`
([PostgreSQL](https://docs.railway.com/databases/postgresql)). Use it once, from a laptop that has the real
`docs/verification/wallets.json`. Keep the URL off the command line and out of shell history: read it without echo
(a variable in the shell wins over `.env`),

```bash
read -rs DATABASE_URL && export DATABASE_URL
VERIFY_WALLETS_FILE=docs/verification/wallets.json npm run export-decision -- [from] [to] [--out dir] [--band-from hour]
unset DATABASE_URL
```

or put `DATABASE_URL=...` in an untracked env file (`.env.*` is gitignored) and name it with `ENV_FILE`:

```bash
ENV_FILE=.env.decision VERIFY_WALLETS_FILE=docs/verification/wallets.json npm run export-decision -- [from] [to] [--out dir] [--band-from hour]
rm .env.decision
```

`from` and `to` are unix hours (inclusive) and bound only the prints export; each fact uses its own default window.
The band's default is the latest 24 stored hours with a JustLend net rate; `--band-from <hour>` judges it over that hour
and the 23 after it instead (for example, the first 24 hours of collection), and `decision.md` states which window was used. `prints.csv` holds the
prints as published: a `no_index` or `thin` row has no price. It
writes `docs/decisions/<UTC date>/` with `prints.csv`, `band.csv`, `facts.json` and `decision.md`; clearability is
included, with nothing to paste. It refuses to replace an existing record of that date; `--force` replaces it and keeps
the old one beside it as `<date>.replaced-<UTC timestamp>`. Then:

1. Write the Decision line in `decision.md` by hand, citing the evidence it rests on.
2. Commit `docs/decisions/<UTC date>/`.

After a `--force` run, instead:

1. Carry the hand-written Decision line over from `docs/decisions/<date>.replaced-<UTC timestamp>/decision.md` into the new
   `decision.md`, if it still holds.
2. Stage the new record by its exact path, so the replaced directory is not swept in:

   ```bash
   git add docs/decisions/<date>/
   ```

3. Decide about the replaced directory: commit it knowingly, as the superseded record, or delete it.

Then, in both cases:

4. Turn Public Access off again and regenerate the database password (Postgres Config tab > Connection, Regenerate;
   [database view](https://docs.railway.com/databases/database-view)), then redeploy the index service so it picks up
   the new `DATABASE_URL`.

## The Nile probe

The locked-delegation questions are answered on the Nile testnet, from a laptop only, with a funded Nile test wallet:
see `docs/verification/nile-lock.md`. Nothing about it runs on Railway.

## Secrets

Secrets: `DATABASE_URL` (and `DATABASE_PUBLIC_URL`), `TRONGRID_API_KEY`, `NETTS_API_KEY`, `ALERT_WEBHOOK_URL`,
`HEALTHCHECK_PING_URL` (its path is the check's id), and, on a laptop only, `NILE_PRIVATE_KEY`. The supplier's wallet
addresses are not a variable at all; they live only in the gitignored wallets file.

Every log line, stored reason and error passes through `redactSecrets` (`src/index/redact.ts`): each URL is cut to
scheme and host, and the value of every secret-named variable (`*_KEY`, `*_SECRET`, `*_TOKEN`, `DATABASE_*URL`,
`*WEBHOOK*`, `*PING_URL`, and others) is replaced with `[redacted]`. A configuration error names the variable, never its
value.
