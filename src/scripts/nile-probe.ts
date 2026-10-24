import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TronWeb } from "tronweb";
import { loadDotEnv } from "./env.js";
import { runScript } from "./exit.js";
import { NILE_FULL_HOST, constructTron, keyRedactionEnv, nileEnv, parseNileArgs } from "./nile.js";
import { runProbe } from "./nile-steps.js";

/** Where every step's line is appended; the human fills docs/verification/nile-lock.md from it. */
const JOURNAL = fileURLToPath(new URL("../../docs/verification/nile-lock.jsonl", import.meta.url));

/**
 * `nile-probe status | delegate <lockBlocks> | undelegate | read`: one step of the Stake 2.0 locked-delegation check on
 * Nile, run by hand on the timeline in docs/verification/nile-lock.md with a funded Nile test wallet. Laptop only.
 *
 * The host is NILE_FULL_HOST and nothing can change it. Before any step, runProbe reads the node's block 0 and compares
 * it with Nile's genesis block id (NILE_GENESIS_BLOCK_ID); any other chain is refused with exit 2, before anything is
 * signed. Reads ask for the latest state (confirmed: false). Each step appends one redacted JSON line {at, step, args,
 * data} to docs/verification/nile-lock.jsonl and prints it. The key is added to the environment in every form it is used
 * before any network call, so every line and every error line is redacted; the TronWeb instance and raw error objects are
 * never printed. Exit 2 for configuration (including a key TronWeb rejects), arguments or a non-Nile node; 1 when the step
 * was refused or the chain rejected it.
 */
await runScript(async () => {
  loadDotEnv();
  const command = parseNileArgs(process.argv.slice(2));
  const cfg = nileEnv();
  Object.assign(process.env, keyRedactionEnv(cfg.privateKey));
  const tron = constructTron(() => new TronWeb({ fullHost: NILE_FULL_HOST, privateKey: cfg.privateKey }));
  return runProbe({
    tron,
    command,
    cfg,
    now: () => new Date(),
    write: (line) => {
      appendFileSync(JOURNAL, `${line}\n`);
      console.log(line);
    },
    env: process.env,
  });
});
