import { writeFileSync } from "node:fs";
import { readAccountEnergyStake, readChainParams, type ChainContext } from "../collectors/chain.js";
import { fetchQuote } from "../collectors/http.js";
import { hourOf } from "../core/hour.js";
import { envValue, parseVerifyRps } from "../index/config.js";
import { redactSecrets } from "../index/redact.js";
import { makeLog } from "../index/wire.js";
import { loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { PACED_FETCH_OPTIONS } from "../collectors/pace.js";
import { buildTop100, parseBuildArgs } from "./top100.js";

/**
 * Builds the top100 section (src/scripts/top100.ts) and writes it, pretty-printed, to the path given; the same JSON goes
 * to stdout as one line, progress to stderr. Reads TRONGRID_API_KEY (getaccount and the chain parameters need it) and
 * VERIFY_RPS; Tronscan is called without a key.
 */
await runScript(async () => {
  loadDotEnv();
  const { out, k } = parseBuildArgs(process.argv.slice(2));
  const apiKey = envValue(process.env, "TRONGRID_API_KEY") ?? "";
  const rps = parseVerifyRps(process.env.VERIFY_RPS);
  const log = makeLog(process.env, process.stderr);
  const redact = (s: string): string => redactSecrets(s, process.env);
  const ctx = (now: Date): ChainContext => ({ hour: hourOf(now), now, apiKey, fetchOptions: PACED_FETCH_OPTIONS, redact });
  const section = await buildTop100({
    k,
    rps,
    log,
    fetchPage: async (url) => {
      const r = await fetchQuote(url, { method: "GET" }, PACED_FETCH_OPTIONS);
      return r.ok ? { ok: true, body: r.body } : { ok: false, reason: `${r.kind}: ${r.reason}` };
    },
    readStake: (address, now) => readAccountEnergyStake(address, ctx(now)),
    readWeight: (now) => readChainParams(ctx(now)),
  });
  writeFileSync(out, `${JSON.stringify(section, null, 2)}\n`);
  console.log(redactSecrets(JSON.stringify(section)));
});
