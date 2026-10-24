import { collect, type CollectContext } from "../collectors/adapter.js";
import { readChainParams } from "../collectors/chain.js";
import { readTrxUsd } from "../collectors/coingecko.js";
import { VENUES } from "../collectors/index.js";
import { hourOf } from "../core/hour.js";
import { envValue, requireEnv } from "../index/config.js";
import { redactConfiguredSecrets, redactSecrets } from "../index/redact.js";
import { SEED_ENERGY_FEE_SUN } from "../index/hour.js";
import { FETCH_OPTIONS, venueEnv } from "../index/wire.js";
import { loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { quoteLine, smokeExitCode, smokeSummary } from "./report.js";

/** Every collector once against the live APIs, one line per quote and a summary; nothing is stored. */
await runScript(async () => {
  loadDotEnv();
  const apiKey = requireEnv(process.env, "TRONGRID_API_KEY");
  const nettsKey = envValue(process.env, "NETTS_API_KEY");
  const redact = (s: string): string => redactSecrets(s, process.env);
  const say = (line: string): void => console.log(redact(line));

  const now = new Date();
  const hour = hourOf(now);
  const [chain, trx] = await Promise.all([readChainParams({ hour, now, apiKey, fetchOptions: FETCH_OPTIONS, redact }), readTrxUsd(FETCH_OPTIONS)]);
  say(chain.ok ? `chain ok fee=${chain.params.energyFeeSun} weight=${chain.params.totalEnergyWeightTrx}` : `chain FAILED ${chain.reason}`);
  say(trx.ok ? `coingecko ok trxUsd=${trx.trxUsd}` : `coingecko FAILED ${trx.reason}`);

  const ctx: CollectContext = {
    hour,
    now,
    energyFeeSun: chain.ok ? chain.params.energyFeeSun : SEED_ENERGY_FEE_SUN,
    trxUsd: trx.ok ? trx.trxUsd : null,
    fetchOptions: FETCH_OPTIONS,
    redact,
    redactValues: (s) => redactConfiguredSecrets(s, process.env),
    env: venueEnv(nettsKey),
  };
  const quotes = (await Promise.all(VENUES.map((v) => collect(v, ctx)))).flat();
  for (const q of quotes) say(quoteLine(q));
  say(smokeSummary(quotes, chain.ok, trx.ok));
  const code = smokeExitCode(quotes, chain.ok);
  if (code === 1) process.stderr.write("chain read failed and no venue answered\n");
  return code;
});
