# Venue APIs: the depth-less venues (iTRX, TRON Energy Market, TronZap, TronPulse, TokenGoodies)

Recorded 2026-10-28 between 04:26:38Z and 04:29:24Z from one machine, to give each new collector a real response to be
tested against. Public endpoints only, no account, no API key, one request per endpoint unless stated. The research
behind the endpoint choices (docs, terms, and the iTRX sample) was done the same day, from 04:13:15Z.
Every recorded body is a fixture in `test/fixtures`, verbatim unless marked constructed.

| Venue | Request | Answer | Fixture | Row status |
| --- | --- | --- | --- | --- |
| iTRX | `GET https://itrx.io/api/v1/frontend/index-data`, no `API-KEY` | 200 JSON (the research sample, 04:13:15Z; not re-requested) | `itrx-index-data.json` | `ok` when `platform_avail_energy` covers 20M, else `no-depth` (12,387,503 at the sample) |
| TRON Energy Market | `GET https://api.tronenergy.market/info` (04:26:38Z) | 200 JSON, 5,779 bytes | `tronenergy-market-info.json` | `ok` (the 30 sun/day level alone held 86,274,460 units) |
| TronZap | `GET https://tronzap.com/api/rates` (04:26:41Z) | 200 JSON, 18,952 bytes | `tronzap-rates.json` | `depth-unknown` (collect-only) |
| TronPulse | `GET https://tronpulse.io/api/energypool/market_settings` (04:26:44Z) | 200 JSON, 3,323 bytes | `tronpulse-market-settings.json` | `depth-unknown` |
| TronPulse | `GET .../api/energypool/order/market_orders` and `GET .../api/energypool/pool/liquidity` (04:26:47Z to 04:26:51Z) | 503 HTML, 237 bytes each | `tronpulse-market-orders-503.html` | not parsed: no success body exists to test against |
| TokenGoodies | `POST https://www.tokengoodies.com/tronresourceexchange/exchange` `{"action":"utils","type":"list_details","rval":1,"sortkey":"payoutamountinsun","limit":5,"offset":0}`, no Origin or Referer (04:26:51Z) | 200 `{"success":false,...,"errormessage":"INVALID_REQUEST",...}` | `tokengoodies-invalid-request.json` | `failed` (the error page served with 200) |
| TokenGoodies | the same POST with `origin: https://www.tokengoodies.com` and `referer: https://www.tokengoodies.com/trade`, as the trade page sends (04:27:22Z) | 200 `{"total":0,"orders":[]}` | `tokengoodies-list-details-empty.json` | `no-depth`, no price |
| TokenGoodies | `{"action":"utils","type":"list_recent_trades","rval":1,"limit":10,"offset":0}` with the same headers (04:27:34Z) | 200 JSON, 16 fills | not kept (it carries wallet addresses); its order rows built the constructed fixture | |
| TokenGoodies | `list_details` with `limit` 50 and the same headers (04:29:24Z), the request the collector sends | 200 `{"total":0,"orders":[]}` | | |

## Notes per venue

**iTRX.** The size quote, `GET /api/v1/frontend/order/price?period=1H&energy_amount=20000000`, answered 35 sun for 20M
and also for 250,000,000, above `maximum_order_energy` and the available energy (research, 2026-10-28). It enforces
no size, so the collector reads the catalog only: `tiered_pricing[period 0].price` (checked against `g1h`) and
`platform_avail_energy`, capped at `maximum_order_energy`. Sending a dummy `API-KEY` turns the answer into
`{"detail":"API not found"}`, so the collector sends none. Terms (itrx.io/terms): "You can't reproduce the data shown
on ITRX website/service in any way/shape/size/form on any other website/service." Collect-only.

**TRON Energy Market.** `market.availableEnergyByPrice` is pool energy by minimum price in sun per unit per day.
A rental under a day is billed as the day plus its length (`price × amount × (duration + 86400) / 86400`, official
examples `nodejs/buy-market.js`), so 1h sun per unit is the daily price × 90,000 / 86,400: 30 sun/day is 31.25.
The price is never below the 1h row's `price.openEnergy[].minPoolPrice` (30 at recording). The ladder is not sliced by
duration. Terms (site modal): "You will not use any automated means to access our systems." Collect-only.

**TronZap.** `price_65k` 2.45 TRX for one 65,000-unit transfer for 1 hour: 37.69 sun per unit. The size quote needs a
Bearer key and an HMAC signature. The body also carries the venue's payment addresses and QR codes. Terms
(tronzap.com/terms, "Last updated: 02.03.2025", re-read 2026-10-28 04:43Z), Intellectual Property: "All content on
TronZap.com, including text, graphics, and logos, is owned by TronZap project unless otherwise stated. You may not
copy, reproduce, or distribute any content without prior permission." No scraping ban as such, but publishing its rate
is reproducing its content without permission. Collect-only (`PUBLISH_TRONZAP`).

**TronPulse.** The `energy_duration` row with `unit` "hour", `value` 1, `block_duration` 1200 has
`energy_min_price` 55: sun per unit for the 1-hour rental, a minimum buy price, not a fill. No scraping clause found
in its terms. Published as `depth-unknown`. When the book endpoints answer 200, record a body and add depth.

**TokenGoodies.** An on-site book of buyers' open orders: `amount`, `filledamount`, `priceinsun`,
`freezeperiodinblocks` (1200 is 1 hour; `freezeperiod` reads 3 on 1h orders too). Depth from it is the size buyers
bid for, not energy on offer. The open book was empty each time it was read, so the non-empty case is tested on
`tokengoodies-list-details-constructed.json`: four `orderdata` rows from the recorded recent trades (two 1h, one
3-day, one 7-day partly filled) with the creator, receiver and source addresses removed. Terms
(resources/disclaimers/terms.htm): personal use only, "You can't reproduce the data shown on TokenGoodies
website/service", "usage of bots on TokenGoodies apps is discouraged". Collect-only.
