# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: the **Security** tab of this repository, then
**Report a vulnerability**. We aim to acknowledge reports within three business days.

Useful reports include: a way to make the index publish a price its rule would not produce, a secret that reaches a
log, a stored reason or the public files, or a way to make the HTTP server serve anything beyond its five paths.

## Scope

This repository publishes a reference price. It holds no funds and signs no mainnet transactions. The Nile probe signs
testnet transactions with a key you supply; use a throwaway wallet.

## Handling secrets

Secrets are read only from environment variables and are redacted from every log line, stored reason and alert
(`src/index/redact.ts`). The wallets file named by `VERIFY_WALLETS_FILE` is gitignored and must never be committed.
