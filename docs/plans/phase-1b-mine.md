# Phase 1B — Mine

Status: done, 2026-10-29. The project owner waived the per-step approval gate for this run (PLAN.md section 11); this file is the plan of record.

**Done when** (PLAN.md section 6): two Map servers mine together on anvil; after a few Retargets, Round time converges to about 60 seconds; rewards go to the correct Land owner wallet; every mine test in section 8 is green.

## Decisions taken in this step

Recorded in `docs/decisions/0003-mine.md`.

- `submit(round, nonce, rewardWallet)` takes the Round number, so a Solution for an old Round fails early with `StaleRound` and miners can tell "lost the race" from "invalid".
- At most one win per block (`RoundAlreadyWonInThisBlock`), so a miner cannot chain precomputed Rounds into one block.
- The next Challenge is `keccak256(abi.encode(previousChallenge, rewardWallet, nonce, blockhash(block.number - 1), block.prevrandao, block.timestamp))`.
- Retarget: every `RETARGET_INTERVAL_ROUNDS` wins, `target = target * clamp(actual, expected / 4, expected * 4) / expected`, saturating at `2^256 - 1` and never below 1. `GoldMine.nextTarget` and `nextTarget` in `packages/shared` are cross-checked with generated vectors.
- Reward: `INITIAL_ROUND_REWARD >> (round / HALVING_INTERVAL_ROUNDS)`; the last reward is cut to what remains under the cap, and Rounds continue with no reward after that.
- `GoldToken` (UUPS, `ERC20Capped`, 21 million) mints only for `GoldMine`, set once with `setMinter`.
- The Mining params are fixed at `initialize`; only an upgrade can change them (P4). On anvil only, `DEV_ROUND_SECONDS`, `DEV_RETARGET_INTERVAL_ROUNDS` and `DEV_INITIAL_TARGET` override them at deploy time so Retargets can be watched within minutes.
- Initial Target: calibrated on the reference machine (the owner's Apple M5) so that one `miner` thread finds a Solution in about 60 seconds.

## Packages

- `packages/miner`: worker threads hashing with `hash-wasm` keccak256; `threads` defaults to 1 and is capped (P5); stops as soon as the Round changes; submits with the Mining key; `bench` script for calibration.
- `packages/map-server`: creates and keeps its Mining key in a local file (never the Land owner's key, P2); mining is off at every start; only the Land owner's session can switch it on or off and choose threads; the room state shows mining status to everyone on the Land (P5); the console says clearly when mining is on. Rewards always go to the Land owner's wallet read from the chain.
- `packages/client`: the Mine on the Land, the Player's `GOLD` balance, the Rounds they won (from chain logs), and the mining switch with hash rate and current Round for the Land owner.
- `packages/indexer`: `round_won` and `retarget` tables from `GoldMine` events.
- Simulation (`contracts/test/GoldMine.simulation.t.sol`): a simulated total hash rate `H` mines real Solutions; each Round takes `nonces tried / H` seconds (`vm.warp`), which is exactly the time a miner of rate `H` would need. `H` rises 4× and then falls to half; the test checks that Round time returns to the intended value after each change. It runs in `forge test`, so CI covers it.

## Interfaces

`@linked-realms/miner` (used by `map-server`):

```ts
interface RoundInfo { round: bigint; challenge: Hex; target: bigint }
/** "lost": another Solution won the Round first (StaleRound, or an on-chain revert after the Round moved on). Other failures throw. */
type SubmitOutcome = "won" | "lost";
interface MinerChain {
  currentRound(): Promise<RoundInfo>;
  submit(round: bigint, nonce: bigint, rewardWallet: Address): Promise<SubmitOutcome>;
}
function createMinerChain(options: { rpcUrl: string; chainId: number; privateKey: Hex }): MinerChain;
interface MinerStatus { on: boolean; threads: number; hashRate: number; round: bigint; submitted: number; won: number; error?: string }
interface MinerOptions { chain: MinerChain; rewardWallet: Address; maxThreads: number; pollIntervalMs?: number; log?: (line: string) => void }
class Miner {
  constructor(options: MinerOptions);
  start(threads: number): void; // clamps to [1, maxThreads]; when already on, applies the new thread count
  stop(): Promise<void>;        // terminates every worker
  status(): MinerStatus;
}
/** Reads the Mining key file, or creates it (mode 0600) with a fresh key. */
function loadOrCreateMiningKey(path: string): { privateKey: Hex; address: Address; created: boolean };
/** max(1, availableParallelism() - 1): leaves one core for the Map server. */
function defaultMaxThreads(): number;
```

The miner learns about a new Round by polling `currentRound()` (default every second) rather than from `RoundStarted` logs: one `eth_call` per second costs nothing, and polling cannot miss a Round the way an expired log filter on a public RPC can. Each worker gets a random 64-bit start nonce and a stride equal to the thread count. On a Solution the workers pause, the miner submits, then reads the Round again and hands out the next job.

`map-server`:

- Config: `MINING_KEY_FILE` (default `packages/map-server/.data/mining-key`, gitignored), `MINING_MAX_THREADS` (default `defaultMaxThreads()`).
- `LandRoomOptions.mining: Pick<Miner, "start" | "stop" | "status">`. The Miner lives for the whole process, so it keeps mining while nobody is on the Land, and the room shows its status to whoever joins.
- Room state `mining` (fields of `MiningStateShape`), refreshed every 500 ms.
- `Messages.mining` from the Land owner's session only, parsed with `parseMiningMessage`, under the same per-session rate limit as input.
- On anvil (chain 31337) the Map server tops up its Mining key with `anvil_setBalance`. On any other chain it prints the Mining key address and balance at start-up so the Land owner can fund it from a faucet.

## Verification

1. `forge test`: section 8 mine tests, invariants (supply cap, Gold only from wins, a cheating server never gets Gold), cross-check vectors.
2. `pnpm test` for the new and changed packages.
3. The simulation test: Round time converges to the intended value after hash rate rises 4× and falls to half.
4. `pnpm --filter @linked-realms/map-server e2e:mining` on anvil deployed with `DEV_ROUND_SECONDS=5` and `DEV_RETARGET_INTERVAL_ROUNDS=10`: two Map servers for two Lands mine together; Round time converges after a few Retargets; every reward lands in the wallet of the Land owner whose Map server submitted it.
