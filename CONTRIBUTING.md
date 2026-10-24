# Contributing

Thank you for helping. Issues and pull requests are welcome.

## Before you start

- For anything larger than a fix, open an issue first so we can agree on the approach.
- Changes to the print rule, the pass conditions or the published JSON shape need a new `METHOD_VERSION`
  (`src/core/types.ts`) and a note in [CHANGELOG.md](CHANGELOG.md). Prints are never rewritten.

## Setup

```sh
npm ci
npm run typecheck && npm test
```

To run the Postgres tests, set `TEST_DATABASE_URL` to a database whose name contains `test` (see the README).

## Rules the code follows

- `src/core` is pure and imports nothing from the other folders. `test/layering.test.ts` checks it.
- Collectors never call `fetch` directly; use `fetchQuote` in `src/collectors/http.ts`. CI checks it.
- A collector returns a typed quote or a typed failure with a reason. It never throws for an upstream problem and never
  skips silently.
- Nothing secret is logged or stored unredacted: pass strings through `redactSecrets` (`src/index/redact.ts`).
- No live network calls in tests. Record the response as a fixture in `test/fixtures/` instead.

## Fixing or adding a venue

1. Save the venue's real response under `test/fixtures/<venue>-<what>.json` (strip anything account-specific).
2. Write or fix the parser in `src/collectors/<venue>.ts`, rejecting any drift with a reason.
3. Add tests: the recorded body, a drifted body, and an error page served with status 200.
4. Register it in `src/collectors/index.ts`.
5. Run `npm run smoke` locally and paste its line for the venue in the pull request.

## Pull requests

- Keep each PR to one change, with tests.
- `npm run typecheck && npm test && npm run build` must pass.
- Write commit messages in the imperative mood, saying why as well as what.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
