# Phase 1B — Mine

Status: in progress, 2026-10-29. The project owner waived the per-step approval gate for this run (PLAN.md section 11); this file is the plan of record.

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

- `packages/miner`: worker threads hashing with `hash-wasm` keccak256; `threads` defaults to 1 and is capped (P5); stops as soon as the Round changes; submits with the Mining key; `bench` script for calibration; `simulate` script that drives a private anvil with simulated hash rates and checks that Round time converges.
- `packages/map-server`: creates and keeps its Mining key in a local file (never the Land owner's key, P2); mining is off at every start; only the Land owner's session can switch it on or off and choose threads; the room state shows mining status to everyone on the Land (P5); the console says clearly when mining is on. Rewards always go to the Land owner's wallet read from the chain.
- `packages/client`: the Mine on the Land, the Player's `GOLD` balance, the Rounds they won (from chain logs), and the mining switch with hash rate and current Round for the Land owner.
- `packages/indexer`: `round_won` and `retarget` tables from `GoldMine` events.

## Verification

1. `forge test`: section 8 mine tests, invariants (supply cap, Gold only from wins, a cheating server never gets Gold), cross-check vectors.
2. `pnpm test` for the new and changed packages.
3. `simulate`: Round time converges to the intended value after hash rate rises 4× and falls to half.
4. Manual on anvil with `DEV_ROUND_SECONDS=5`: two Map servers for two Lands mine together; Round time converges after a few Retargets; every reward lands in the winning Land owner's wallet.
