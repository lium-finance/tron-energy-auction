# Top-100 energy stakers: source probe

Probed 2026-10-22 (15:55 to 16:10 UTC), keyless, read-only requests, at most one request every 2 s. The question: does Tronscan
expose, without an API key, a ranking of accounts by **energy** stake, with a field to compute each account's share of
`TotalEnergyWeight`?

**Finding: no.** Tronscan's keyless account list ranks by total stake (`power`) or balance, never by energy stake, and
returns no field that splits a stake between energy and bandwidth. The per-account endpoint that would carry the split
(`/api/accountv2`) answers 401 without a key.

**So the list is built in two steps** (approved 2026-10-22, `src/scripts/build-top100.ts`): the top K by `power` from
Tronscan, then each account's own energy stake from TronGrid `wallet/getaccount` (request 4 below). See "How the
builder works".

## Requests and answers

1. The first URL tried, sorted by `-totalFrozen`:

   ```
   GET https://apilist.tronscanapi.com/api/account/list?sort=-totalFrozen&limit=5&start=0
   ```
   HTTP 400, whole body:
   ```
{"message":"some parameters are invalid or out of range"}
   ```
   `sort=-energy`, `sort=-frozenForEnergy`, `sort=-energyLimit` and `sort=-totalFrozenV2` (limit=3) gave the same 400 body.

2. Sorted by `-power` (accepted; `-balance` is accepted too and returns the same fields):

   ```
   GET https://apilist.tronscanapi.com/api/account/list?sort=-power&limit=3&start=0
   ```
   HTTP 200, first 600 bytes:
   ```
{"account_number":410188221,"last_24h_account_change":152331,"total":10000,"data":[{"address":"TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5","addressTagLogo":"","balance":25500050535027,"unstakingBalance":6979607729209,"power":9835024853068643,"totalBalance":9867504511332879,"totalTransactionCount":116509,"trxRatio":"0.103859823195508670","latestOperationTime":1792684434000,"updateTime":1792684434000},{"address":"TM3sTVyahiGWYktKg8G6miHpTzRurKDt7b","addressTagLogo":"","balance":88952319366263,"unstakingBalance":0,"power":1170992987000000,"totalBalance":1259945306366263,"totalTransactionCount":930,"trxRa
   ```
   Fields per account: `address`, `addressTag`, `addressTagLogo`, `balance`, `unstakingBalance`, `power`,
   `totalBalance`, `totalTransactionCount`, `trxRatio`, `latestOperationTime`, `updateTime`. `power` reads as the account's
   total staked TRX in sun (voting power, energy and bandwidth stakes together; e.g. the sTRX contract above shows
   9.84e15 sun, about 9.8 billion TRX); nothing in the answer splits it by resource. `total` is 10000 (the list is capped).

3. The per-account detail, which in Tronscan's UI carries the energy/bandwidth split:

   ```
   GET https://apilist.tronscanapi.com/api/accountv2?address=TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5
   ```
   HTTP 401, an openresty "401 Authorization Required" HTML page (needs a Tronscan API key).

4. TronGrid's account read, for the largest staker (the sTRX contract, public):

   ```
   POST https://api.trongrid.io/wallet/getaccount
   content-type: application/json
   {"address":"TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5","visible":true}
   ```
   HTTP 200 (sent without a key on 2026-10-22; 3,846 bytes, saved whole as
   `test/fixtures/trongrid-getaccount-strx.json`), first 600 bytes:
   ```
{"account_name": "STRXProxy","type": "Contract","address": "TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5","balance": 25500050535027,"votes": [{"vote_address": "TJvaAeFb8Lykt9RQcVyyTFN2iDvGMuyD4M","vote_count": 1966961222},{"vote_address": "TJBtdYunmQkeK5KninwgcjuK1RPDhyUWBZ","vote_count": 1966961222},{"vote_address": "TGJBjL8wmRVyRStkghnhcVNYYgn6Yjno6X","vote_count": 1966961222},{"vote_address": "TCZvvbn4SCVyNhCAt1L8Kp1qk5rtMiKdBB","vote_count": 1966961222},{"vote_address": "TTW663tQYJTTCtHh6DWKAfexRhPMf2DxQ1","vote_count": 1966961222}],"latest_withdraw_time": 1792670412000,"net_window_size": 28800000,"
   ```
   The stake fields further down the same answer:
   ```
   "frozenV2": [{"amount": 4835024853068643}, {"type": "ENERGY", "amount": 3390507802431338}, {"type": "TRON_POWER"}]
   "account_resource": {..., "delegated_frozenV2_balance_for_energy": 1609492197568662, ...}
   ```
   The untyped `frozenV2` entry is bandwidth. Bandwidth + ENERGY + energy delegated out =
   4,835,024,853,068,643 + 3,390,507,802,431,338 + 1,609,492,197,568,662 = 9,835,024,853,068,643 sun, exactly the
   `power` Tronscan reports for this account in request 2. That confirms `power` is total own stake, and that energy
   staked then delegated out leaves `frozenV2` and must be added back: without it sTRX's energy stake would read
   3.39 billion TRX instead of 5.00 billion.

## How the builder works

`npm run build-top100 -- <out.json> [--k N]` (K defaults to 300):

1. The top K by `power` from request 2, 50 rows a page (a 50-row page, `limit=50&start=0`, answered 200 with 50 rows
   in descending `power`; saved as `test/fixtures/tronscan-account-list-power-50.json`), at least 2 s between pages; a
   rate-limited page is retried once 2 s later. A ranking
   that repeats an account or is out of order (it shifted between pages) fails the run.
2. For each account, `wallet/getaccount` through TronGrid with `TRONGRID_API_KEY`, paced at `VERIFY_RPS` (default 2 a
   second) with one retry 2 s after a rate limit. Energy stake = the `frozenV2` entry of type `ENERGY` +
   `account_resource.delegated_frozenV2_balance_for_energy`, plus the Stake 1.0 fields when present
   (`account_resource.frozen_balance_for_energy.frozen_balance`, `account_resource.delegated_frozen_balance_for_energy`;
   the recorded answer has none, so they are tested on a constructed answer,
   `test/fixtures/trongrid-getaccount-stake1-constructed.json`). Requests use fetch options with no hedged second request
   and no 429 backoff inside fetchQuote, so the pacer's single retry is the only one. Any failed read fails the run: a
   partial ranking cannot be trusted.
3. Sort by energy stake and keep the top 100 with a stake above zero.
4. `exact` is true only when the 100th energy stake is at least the K-th account's `power` (no account outside the K has
   more total stake, so none has more energy stake), and no stake exceeds its account's `power`. Otherwise the run says
   to raise `--k`. Tronscan's `power` is an indexed snapshot (each row carries an `updateTime`), not a chain read, and
   the getaccount reads come minutes later, so a stake that moved in between can shift the bound slightly.
5. `shareOfTotalEnergyWeight` = sum of the 100 stakes in TRX / `TotalEnergyWeight` (TRX) from `readChainParams`.

The output is a top100 section `{source, readAt, k, exact, shareOfTotalEnergyWeight, energyStakeTrx, delegatedOutTrx,
delegatedOutShare, wallets}`, written to the path given and printed on stdout. Each wallet is
`{address, energyStakeTrx, delegatedOutTrx}`: delegated out is `delegated_frozenV2_balance_for_energy` plus the Stake 1.0
`delegated_frozen_balance_for_energy`. Progress lines name accounts by rank (`rank 37`), never by address.

Utilisation stays the utilisation of the energy the listed stakers keep: energy they delegate out is
used by its recipients and is not in their `EnergyUsed`, so the figure is a lower bound on how busy the listed stake is.
`verify-utilisation` prints `delegatedOutShare` (total delegated out / total energy stake of the list, null when the list
carries no stake numbers) and a `measures` line saying so. The wallets file accepts `top100.wallets` entries as plain
addresses or as these objects; the numbers are optional, and must be finite and at least 0 when present. These are public addresses, so it may be committed as `docs/verification/top100-<date>.json` and
named from the gitignored `wallets.json` with `"top100File": "top100-<date>.json"` (resolved against the wallets file's
directory) in place of an inline `top100`.

A live run with `--k 5` and no `TRONGRID_API_KEY` (2026-10-22) ranked 5 accounts and then stopped cleanly:
`getaccount failed for TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5: API key is empty` (exit 1, nothing written). TronGrid answers
getaccount without a key (request 4), but the chain reader refuses an empty key like every other TronGrid read here.
