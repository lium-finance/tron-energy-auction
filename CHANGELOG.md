# Changelog

All notable changes are listed here. Method changes carry the `METHOD_VERSION` they introduce.

## 0.1.0

First public release.

- The hourly index for 20,000,000 energy units over one hour: collectors for TronSave, TronBid, GetBlock, NetTS,
  JustLend, CoinGecko and the TronGrid chain reader; the print rule; `latest.json`, `history.json` and the page.
- Method `2026-10-23.1`: a `thin` hour publishes no price, as a `no_index` hour does.
- The four fact scripts (supplier, utilisation, band, clearability) and the dated decision record export.
- Dead-man ping, degraded-data and thin-share alerts; secret redaction on every log, reason and alert.
- The Nile locked-delegation probe.
