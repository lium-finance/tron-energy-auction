# Changelog

All notable changes are listed here. Method changes carry the `METHOD_VERSION` they introduce.

## Unreleased

- A collector for TronPulse: its keyless 1-hour minimum price published as a `depth-unknown` row.
- Collectors for iTRX, TRON Energy Market, TronZap and TokenGoodies, collect-only: stored, never counted in a print,
  published or used in a decision record unless `PUBLISH_ITRX`, `PUBLISH_TRONENERGY_MARKET`, `PUBLISH_TRONZAP` or
  `PUBLISH_TOKENGOODIES` is `on`.
- An empty order book is a `no-depth` row with no price.

## 0.1.0

First public release.

- The hourly index for 20,000,000 energy units over one hour: collectors for TronSave, TronBid, GetBlock, NetTS,
  JustLend, CoinGecko and the TronGrid chain reader; the print rule; `latest.json`, `history.json` and the page.
- Method `2026-10-23.1`: a `thin` hour publishes no price, as a `no_index` hour does.
- The four fact scripts (supplier, utilisation, band, clearability) and the dated decision record export.
- Dead-man ping, degraded-data and thin-share alerts; secret redaction on every log, reason and alert.
- The Nile locked-delegation probe.
