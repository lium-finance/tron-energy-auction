# Nile lock probe (template: not run)

The auction's delivery idea depends on Stake 2.0 locked delegation. These five questions are answered on the Nile testnet,
by a person with a funded Nile test wallet, by running `npm run nile-probe` one step at a time on the timeline below. Every
step appends one JSON line `{at, step, args, data}` to `docs/verification/nile-lock.jsonl` and prints it; fill the results
table from those lines, citing the `at` of each line you used.

Nothing here has been run yet. Every result cell says "not run".

## Questions

- Q1. Does `delegateResource` accept `lock: true` with a 1-block `lock_period`, and with 1200 blocks (1 hour at 3 s)?
- Q2. While locked, is `undelegateResource` rejected, and with what error?
- Q3. Adding a second locked delegation to the same receiver: is a `lock_period` shorter than the remaining lock rejected?
  With an equal or longer one, does the expiry move and do the amounts merge? (`read` before and after.)
- Q4. After expiry, does undelegate succeed?
- Q5. What does TVM `receiver.resourceV2(from, 1)` return, in both argument orders, and in which unit: sun of staked TRX or energy?

## Safety

- The probe talks only to `https://nile.trongrid.io` (a constant; no variable or flag changes it). Before any step it reads
  block 0 and refuses (exit 2) unless its id is Nile's genesis block id,
  `0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc`.
- Use a throwaway Nile wallet. Never a key that holds anything on mainnet.
- The key is read from `NILE_PRIVATE_KEY` (in `.env`, which is gitignored) and is never printed; every journal line is redacted.

## Setup

1. Make a new Nile wallet, take test TRX from the Nile faucet, and stake (freeze, Stake 2.0) at least 2 x `NILE_AMOUNT_TRX`
   plus a margin for ENERGY. Keep some unstaked TRX for bandwidth and fees.
2. Pick a receiver: a second Nile address you control (`NILE_RECEIVER`, base58).
3. Put in `.env` (gitignored):

   ```
   NILE_PRIVATE_KEY=<64 hex characters, test wallet only>
   NILE_RECEIVER=T...
   NILE_AMOUNT_TRX=100
   # after deploying the probe contract (below):
   NILE_PROBE_ADDRESS=T...
   ```

4. Check: `npm run nile-probe -- status` prints the wallet address, its staked energy (`account.frozenV2EnergySun`),
   what it can delegate (`canDelegate.maxSun`) and any delegations to the receiver (`delegations.list`). Every read asks
   the fullnode for the latest state, not the solidity node's confirmed one, and the line says so (`confirmed: false`).

### Deploy the probe contract (for Q5)

`contracts/probe/ResourceProbe.sol` has two view functions over `resourceV2`. tronbox is not a dependency of this repository
and no `tronbox.js` is committed: deploy from a scratch directory outside the repository with a pinned tronbox.

```sh
mkdir -p /tmp/nile-probe/contracts /tmp/nile-probe/migrations
cp contracts/probe/ResourceProbe.sol /tmp/nile-probe/contracts/
cd /tmp/nile-probe
cat > tronbox.js <<'JS'
module.exports = {
  networks: {
    nile: { privateKey: process.env.NILE_PRIVATE_KEY, fullHost: "https://nile.trongrid.io", network_id: "3" },
  },
  compilers: { solc: { version: "0.8.20" } },
};
JS
cat > migrations/1_probe.js <<'JS'
const P = artifacts.require("ResourceProbe");
module.exports = (deployer) => deployer.deploy(P);
JS
npx tronbox@4.11.0 compile
# Load the key from the repository's .env rather than typing it: a key on the command line is kept in shell history
# and is visible to other processes (ps) while tronbox runs.
set -a; . <path to the repository>/.env; set +a
npx tronbox@4.11.0 migrate --network nile
```

If the compiler version does not know `resourceV2`, set a newer TRON solc version that supports Stake 2.0. Record the
deployed address here and in `.env` as `NILE_PROBE_ADDRESS`. Without it, `read` records the delegations and says the
contract reads were skipped.

Probe contract address (Nile): not deployed

## Steps

| Command | What it does |
| --- | --- |
| `npm run nile-probe -- status` | wallet address, staked energy, can-delegate maximum, delegations to the receiver with expiry times |
| `npm run nile-probe -- delegate <lockBlocks>` | refuses if `NILE_AMOUNT_TRX` exceeds the can-delegate maximum; else delegates that amount of ENERGY stake to the receiver with `lock: true` and `lock_period = lockBlocks` (1 to 864000), and records the txid or the chain's error |
| `npm run nile-probe -- undelegate` | undelegates `NILE_AMOUNT_TRX` of ENERGY stake from the receiver and records the result or the chain's error |
| `npm run nile-probe -- read` | `getDelegatedResourceV2(wallet, receiver)` and, with `NILE_PROBE_ADDRESS`, the probe's `delegated(receiver, wallet)` and `reverse(receiver, wallet)` |

Each step is one run: no step waits or sleeps. Exit 2 means configuration, arguments or a node that is not Nile; exit 1
means the step was refused or the chain rejected it (the line is still written).

## Timeline

Run each line at the stated time. One block is about 3 s, so 1200 blocks is about 1 hour.

The steps from t1 run one after another, each as soon as the one before has printed its line. The last two wait for the
lock to expire: their time comes from the `expireTimeForEnergyUtc` the last `read` printed, not from a clock started at t1.

| When | Command | Answers |
| --- | --- | --- |
| t0 | `status` | baseline |
| t0 | `delegate 1` | Q1 (1 block) |
| t0 + 10 s | `undelegate` | Q4 (short lock expired) |
| t1 | `delegate 1200` | Q1 (1200 blocks) |
| right after | `undelegate` | Q2 (locked: expect a rejection; record the error text) |
| right after | `read` | Q3 before (expiry and amount), Q5 |
| right after | `delegate 600` | Q3 (shorter than the remaining lock) |
| right after | `delegate 1200` | Q3 (equal or longer: does the expiry move, do the amounts merge?) |
| right after | `read` | Q3 after (compare expiry and amount with the read before), Q5 |
| 5 min after `expireTimeForEnergyUtc` in the last `read` (about 65 min after the second `delegate 1200`'s `at`) | `undelegate` | Q4 (after the lock; run it again if two amounts were merged) |
| right after | `read` | Q4 after |

## Results

Fill from `docs/verification/nile-lock.jsonl`, citing each line's `at`.

| Question | Result | Evidence (journal `at`) |
| --- | --- | --- |
| Q1. 1-block lock accepted? 1200-block lock accepted? | not run | not run |
| Q2. Undelegate while locked rejected? Error text | not run | not run |
| Q3. Shorter second lock rejected? Equal or longer: expiry moved, amounts merged? | not run | not run |
| Q4. Undelegate after expiry succeeds? | not run | not run |
| Q5. `resourceV2` in both argument orders: values and unit (sun of staked TRX or energy) | not run | not run |
