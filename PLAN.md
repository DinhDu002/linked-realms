# PLAN.md — Execution plan for `linked-realms`

> `linked-realms` is a working name and can be changed at any time.
> This document is for both humans and Claude Code. **Claude Code:** read the whole file before starting, follow the phases in order, and update section 12 (Progress) after every completed task.

## 0. How to use this document

1. Put `PLAN.md` and `CLAUDE.md` at the root of an empty repo.
2. Read and settle section 10 (Decisions to confirm), especially D8–D10 about the mine. If you choose something other than the default, edit this file directly.
3. Open Claude Code in the repo folder and ask: "Read PLAN.md, present a detailed plan for Phase 0, and wait for my approval before doing anything."
4. Work on one phase at a time. Move to the next phase only when the current one meets every "Done when" criterion.

## 1. Product vision

- Each player hosts their own server, and each server is one land. Lands join into one shared world through a network operated by the company (called the **Hub**).
- Each player controls **one main character**.
- **Stage 1** contains only: one land, one character (every stat equals 1) and one gold mine. Once servers are connected to each other, a character can walk into another player's land.
- The **gold mine** works by Proof of Work like Bitcoin: the player's machine computes hashes, and whoever finds a valid solution first is rewarded with gold.
- Open source. **The project owner decides** which changes are merged into the main version.
- Ideas beyond stage 1 are in section 7.

## 2. Invariant principles

Every design and every line of code must follow the principles below. If a request conflicts with them, **stop and ask**. Only the project owner may edit this section.

- **P1 – Do not trust map servers.** Servers are hosted by players and their code can be modified. Every piece of state that affects other players (characters, land, gold, wins and losses) must be decided by smart contracts.
- **P2 – No server holds a player's main key.** Players sign their own transactions with their own wallets. A map server uses only a separate **mining key**, which holds no assets, to submit solutions; rewards always go to the land owner's wallet.
- **P3 – Pay rewards only after the contract checks the solution itself.** The contract recomputes the hash and compares it with the target; it never pays a reward based on a server's report.
- **P4 – Gold is issued on a fixed schedule.** A reward per round, halved periodically, self-adjusting difficulty, capped total supply. There is no other way to create gold.
- **P5 – Mining is voluntary.** The mining process runs only when the machine's owner actively turns it on, has a CPU limit, and clearly shows that it is mining. Never mine covertly.
- **P6 – Maps are data, not code.** The client never runs arbitrary code received from another player's server. Tilemaps must be validated for format and size.
- **P7 – Testnet only.** Do not deploy to mainnet; gold has no real value until Phase 3 and a written decision.
- **P8 – Heavy data stays off-chain.** Detailed land designs and images are stored off-chain (their hash may be stored on-chain).
- **P9 – Rules have a single source.** The puzzle format, the difficulty formula and the issuance schedule are defined once in `packages/shared/src/rules`, are tested, and the contracts must produce identical results.
- **P10 – Design for extension.** Character stats and object types are stored as key–value pairs, so new ones can be added later without migrating data.

## 3. Architecture

### 3.1 Components

| Component | Operated by | Role |
|---|---|---|
| `contracts/` | Blockchain | Characters, land, mine (checks solutions, pays rewards), `GOLD` token |
| `packages/map-server` | Player | Real-time simulation of the land, controls the mining process |
| `packages/miner` | Player | Mining process: tries nonces, finds solutions, submits them on-chain |
| `packages/client` | Player | Plays the game, shows the mine and balances, signs transactions |
| `packages/hub-api` | Company | Server directory, authentication, abuse reports |
| `packages/relay` | Company | Forwards real-time connections to map servers |
| `packages/indexer` | Company (anyone can run it) | Reads on-chain events into Postgres: list of lands, mining history |
| `packages/shared` | — | Data types, rules, ABIs, contract addresses |

### 3.2 Repo structure

```
linked-realms/
├── CLAUDE.md
├── CONTEXT.md            # domain glossary
├── PLAN.md
├── compose.yaml          # local dev environment
├── .github/workflows/    # CI
├── contracts/            # Solidity + Foundry
├── packages/
│   ├── shared/
│   ├── hub-api/
│   ├── map-server/
│   ├── miner/
│   ├── client/
│   ├── relay/
│   └── indexer/
├── maps/                 # sample lands (Tiled JSON)
└── docs/
    └── decisions/        # ADRs: one file per architecture decision
```

### 3.3 Where data lives

| Data | Stored in | Why |
|---|---|---|
| Main character and stats | Chain | Shared across lands |
| Land, coordinates, the mine attached to the land | Chain | Ownership, position in the world |
| Gold (`GOLD`), mining rounds, target, winners | Chain | Anti-cheat (P1, P3, P4) |
| Detailed land design | Map server (hash stored on-chain) | Heavy data (P8) |
| Position, transient animation | Map server | Real-time, does not affect others |
| Mining key | Machine running the map server | Only pays fees for submitting solutions, holds no assets |
| Server directory, online status | Hub (Postgres) | Changes constantly |

### 3.4 Main flows

- **Registering a land:** the land owner signs a message delegating authority to the map server's key → `hub-api` checks the signature against the on-chain owner of the `Land` → the map server appears in the directory. The map server connects outward to `relay` on its own, so players do not need to open any port.
- **Travelling to another land:** the client leaves land A → the Hub issues a signed, short-lived travel ticket → the client enters land B. The character and stats are read from the chain; only position is off-chain.
- **Mining gold:**
  1. The `GoldMine` contract publishes the current round's challenge and target.
  2. `miner` tries `nonce` values one after another, computing `hash(challenge, land owner wallet, nonce)`.
  3. When it finds a hash below the target, `miner` sends the transaction `submit(nonce, land owner wallet)` using the mining key.
  4. The contract recomputes the hash itself, checks it against the target and checks that the receiving wallet owns a land, then mints gold to that wallet and opens a new round with a new challenge. Every other solution for the old round becomes invalid automatically.
  5. After every fixed number of rounds, the contract retargets to keep the average pace at the intended round time.

### 3.5 Connection scaling rules (D4)

Target: about 1,000 concurrent players for testnet and Phase 2, with a protocol that reaches 100,000+ without a rewrite. Long-lived connections land on `relay`, not on `hub-api`. Evidence and sources: `docs/research/2026-10-29-connection-scaling.md`.

1. Every map server link and every client connection carries the land id in its URL, so relay nodes can later be routed by land id.
2. The relay forwards both the Colyseus HTTP matchmaking request and the WebSocket upgrade.
3. Entering a land requires a travel ticket: the map server verifies it offline and only then reserves a seat.
4. Online status comes from the map server's live connection to the relay, not from HTTP heartbeats to `hub-api`.
5. Directory responses are cacheable (`s-maxage` + `stale-while-revalidate`).
6. The relay counts bytes and messages per session, so any decision to move traffic off the relay (for example WebRTC) is based on measured data.
7. WebSocket compression is off; frame size is limited (at least Colyseus's default `maxPayload` of 4,096 bytes); slow clients get bounded buffering.
8. A load-test harness with a non-JavaScript client exists from the first relay version.

Tiers: up to ~1,000 players → one Node.js `ws` relay process; ~10,000 → several relay nodes routed by land id, on uWebSockets.js; 100,000+ → a sharded relay fleet whose engine is chosen by load test (Go if Node.js falls short).

## 4. Default technology stack

Items marked (*) need confirmation in section 10.

- **Monorepo:** pnpm workspaces + Turborepo, TypeScript (strict), Node.js 26 (current LTS).
- **Testing:** Vitest (TypeScript); Foundry `forge test` (Solidity, including fuzz and invariant tests); Slither for static analysis of the contracts.
- **Contracts:** Solidity + Foundry + OpenZeppelin Contracts; core contracts are upgradeable via UUPS, with upgrade rights held by the project owner's multisig wallet. Local chain: `anvil`. Testnet: Base Sepolia (*).
- **Chain access:** viem.
- **Map server:** Node.js + Colyseus 0.18 (*). Each room is one land; the server is authoritative.
- **Miner:** TypeScript in a worker thread, with the hash function in WASM (for example `hash-wasm`) so it is fast enough, and a limit on CPU threads.
- **Client:** Phaser 4, top-down 2D, runs in the browser (*).
- **Maps:** made with the Tiled Map Editor, exported as JSON.
- **Hub API:** TypeScript on Node.js (Hono or Fastify) + viem (D4). **Relay:** Node.js + `ws`, moving to uWebSockets.js and then a sharded fleet as load grows (section 3.5).
- **Indexer:** Ponder + PostgreSQL.
- **Sign-in:** Sign-In with Ethereum (EIP-4361). **Wallets:** anvil wallets for development, browser wallets for internal testing, and an embedded wallet + ERC-4337 paymaster before opening to outsiders (*).
- **Infrastructure:** Docker, `compose.yaml` (`docker compose` v2 command, no `version` key), PostgreSQL `-alpine` images, every image pinned to a version (no `:latest`).

## 5. Rules for stage 1

The values below are defaults. They live in `packages/shared/src/rules`, and the contracts are configurable so they can be tuned later.

### 5.1 Land and characters

- Each wallet can create exactly 1 character and 1 land. Every land comes with 1 mine.
- All mines take part in one shared mining competition: each round has one winner across the whole world, not one per land.
- A character has 4 stats, all equal to 1: strength, agility, intelligence, stamina. Stage 1 has no way to raise stats.
- A land is empty and flat, 64×64 tiles, and receives its coordinates automatically along a spiral from the centre of the world. The mine sits in the middle of the land.
- A character walks around its own land and into adjacent lands through gates on the four edges. Visitors can only walk and look; they cannot interact with the land owner's mine.

### 5.2 Mine

- **Puzzle (D8):** find a `nonce` such that `keccak256(abi.encode(challenge, reward wallet, nonce)) < target`.
- **Reward recipient:** must be a wallet that currently owns a land. Because the reward wallet is part of the hash, changing the recipient makes the solution invalid, so copying someone else's solution does not work.
- **One winner per round:** the first valid solution is recorded. The new round's challenge is derived from the old challenge, the winner, the winning nonce and data from the current block.
- **Intended round time (D9):** 60 seconds per round.
- **Retarget (D9):** every 60 rounds, multiply the target by `actual time / intended time`, changing it by at most 4× in either direction each time (as in Bitcoin).
- **Reward (D9):** 50 `GOLD` per round, halved every 210,000 rounds. Maximum total supply is 21 million `GOLD`; only `GoldMine` can mint. At 60 seconds per round, 210,000 rounds take about 146 days, so 93.75% of the supply is mined within about 19 months (4 halvings).
- **Initial target (D9):** measured in step 1B — set so that one `miner` thread on the reference machine finds a solution in about 60 seconds. Record the value in `rules` and in an ADR.
- **Voluntary mining (P5):** off by default. When on, it uses at most 1 CPU thread, and the player can adjust this. `miner` stops immediately when the round changes so no work is wasted.
- **Mining key:** the map server creates its own wallet just to pay fees for submitting solutions. On testnet, use a faucet or a paymaster.

## 6. Roadmap

### Phase 0 – Foundations

**Goal:** the repo, tooling and dev environment run with a single command.

- [x] Initialise the pnpm + Turborepo monorepo, TypeScript strict, ESLint, Prettier, Vitest.
- [x] Initialise `contracts/` with Foundry; install OpenZeppelin Contracts (regular and upgradeable).
- [x] Create `compose.yaml` for development with PostgreSQL (`-alpine`) and `anvil`, versions pinned.
- [x] Create `packages/shared` with the `rules` skeleton and a sample test.
- [x] CI (GitHub Actions): lint, test, `forge test`, Slither.
- [x] Record the choices from section 10 in `docs/decisions/0001-initial-decisions.md`.
- [x] `README.md`, `.env.example`, `LICENSE` (per D6).
- [x] `CONTRIBUTING.md` stating that every PR is reviewed and merged by the project owner (moved from Phase 2: the repo is public from day one).
- [x] GitHub settings: secret scanning and push protection on; `main` protected (PR required, no force-push).

**Done when:** `pnpm install && pnpm test` and `forge test` are green; `docker compose up -d` runs Postgres and anvil; CI is green.

### Phase 1 – Stage 1: land, characters, mine and connectivity

Split into three steps, done in order.

#### 1A – Land and characters

- [x] `PlayerRegistry` contract (UUPS): one character per wallet, non-transferable; stats stored as key–value pairs, all initialised to 1.
- [x] `Land` contract (ERC-721, UUPS): one land per wallet; spiral coordinates assigned automatically; stores the hash of the land design.
- [x] `indexer` (Ponder) reads events from both contracts into Postgres.
- [x] `map-server`: a Colyseus room for one empty 64×64 land; several people join, see each other and walk around.
- [x] `client` (Phaser): create a character by signing a transaction, view stats, walk around.

**Done when:** on anvil, a player creates a character with 4 stats equal to 1, receives a land and walks around; two clients on the same land see each other.

#### 1B – Mine

- [x] `GoldToken` contract (ERC-20 `GOLD`): 21 million cap, only `GoldMine` can mint.
- [x] `GoldMine` contract: rounds, challenges, solution checks, checking that the reward wallet owns a land, rewards, halving, retargeting as in section 5.2.
- [x] `packages/miner`: worker thread that tries nonces, CPU limit, watches events to stop when the round changes, submits solutions with the mining key.
- [x] `map-server`: mining on/off switch for the land owner, showing hash rate and the current round.
- [x] `client`: shows the mine on the land, the `GOLD` balance, and the history of rounds won.
- [x] Simulation script: raise and lower the total hash rate, and check that round time converges to the intended value.

**Done when:** two map servers mine together on anvil; after a few retargets, round time converges to about 60 seconds; rewards go to the correct land owner wallet; every mine test in section 8 is green.

#### 1C – Connectivity and travel between lands

- [x] `hub-api` (TypeScript, D4): register map servers using the land owner's delegation signature, directory, online status, SIWE sign-in, abuse reports and removal from the directory.
- [x] `relay`: map servers connect outward to the relay; clients enter a land through the relay; follows the rules in section 3.5.
- [x] Gates on the four edges of a land lead to the adjacent land according to on-chain coordinates; travel tickets are signed and short-lived.

**Done when:** three map servers run in three separate containers; a player walks through a gate from land A to land B; shutting down A makes the directory show it as offline.

**Stage 1 is done when:** on testnet, at least 3 players on 3 different machines each have a character, a land and a mine that is mining; they can walk into each other's lands; gold is paid according to the rules.

### Phase 2 – Open source and testing (testnet)

**Goal:** people outside the team can host their own land and play reliably.

- [ ] Docker image that runs the map server and miner with one command; self-hosting guide.
- Moved to Phase 0 because the repo is public from day one: settling the licence (D6), making the repo public, `CONTRIBUTING.md` stating that the project owner reviews every PR.
- [ ] Embedded wallet + paymaster (D5) so new players do not need to install a wallet or pay gas. The paymaster only sponsors game transactions, with rate limits.
- [ ] Dashboard: number of lands online, number of mines mining, estimated hash rate, round time, winner distribution.

**Done when:** at least 10 lands hosted by people outside the team stay connected reliably for one week.

### Phase 3 – Mainnet preparation (only with a written decision)

- [ ] Security audit of every contract, especially `GoldMine` and `GoldToken`.
- [ ] Legal review before gold has real value (token, mining activity, player-hosted content).
- [ ] Choose Base mainnet or a dedicated chain (OP Stack or Arbitrum Orbit).
- [ ] Revisit the issuance parameters using testnet data.

## 7. Ideas beyond stage 1

Not part of stage 1. The project owner will decide the order.

| Idea | Design notes |
|---|---|
| Spend gold to build and upgrade | Every spend and every structure that has an effect must be on-chain (P1) |
| Raise character stats | Stats rise through activity recorded on-chain, not through server reports |
| Upgrade the mine | If upgrades multiply the reward, mining is no longer pure Proof of Work; the issuance schedule must be redesigned (P4) |
| AI-driven NPCs | The LLM only chooses actions within a schema that is validated again; in-game content is never an instruction to the AI |
| Renting out NPCs | Prepaid escrow, the owner withdraws gradually over time, ending early refunds the remainder |
| Troops and conquering land | Resolved on-chain with a fixed formula; protective shields and protection for new players |

## 8. Testing and quality

- Every package has tests. CI runs lint, tests, `forge test` and Slither on every PR.
- **Land and characters:** one character per wallet, one land per wallet; stats all initialised to 1; no duplicate coordinates.
- **Mine (unit, fuzz, invariant):**
  - Wrong solutions are rejected.
  - Solutions for an old round are rejected.
  - Changing the reward wallet invalidates the solution.
  - A wallet that owns no land receives no reward.
  - Retargeting follows the formula and never exceeds the 4× limit.
  - Halving happens at the right round; total supply never exceeds 21 million.
  - No address other than `GoldMine` can mint gold.
- **Cross-check tests:** for the same input, `miner` (TypeScript) and the contract compute the same hash; `rules` and the contract produce the same target.
- **"Cheating server" tests:** a map server with modified code cannot get gold without a valid solution.
- **End-to-end:** compose brings up anvil, Hub, relay and 2 map servers; scenario: create a character → turn mining on → receive gold → walk through a gate into the other land.

## 9. Security and risks

| Risk | Mitigation |
|---|---|
| Players with powerful machines or GPUs win almost every round | Accepted, as in Bitcoin; track the winner distribution on the dashboard |
| Players write their own optimised mining tools outside the game | Cannot be prevented with open source; rewards still depend only on hash rate |
| Copying another player's solution | The reward wallet is part of the hash; changing the recipient invalidates the solution |
| Solutions submitted late, after the round already has a winner | `miner` watches events and stops immediately; a failed transaction only costs a small fee |
| Players' machines run hot and use power; the software is flagged as coin-mining malware | P5: voluntary mining, off by default, CPU limit, clearly shown |
| Paymaster abused for spam | Only sponsor game transactions, rate-limited per land |
| Map server code modified to cheat | P1, P3 |
| Malicious server attacks clients | P6; data size limits |
| Leaked private keys or secrets | P2; the mining key holds no assets; `.env.example`; secret scanning in CI |
| Rule-breaking content on player-hosted lands | Report and remove from the Hub directory; terms of use |
| Legal exposure once gold has real value | P7; legal review before mainnet |

## 10. Decisions to confirm

| # | Decision | Choice | Alternatives | Status |
|---|---|---|---|---|
| D1 | Client | Phaser 4 in the browser | Godot 4, Unity | Confirmed 2026-10-29. The original default was Phaser 3; Phaser 4 is the current major version. |
| D2 | Map server networking | Colyseus 0.18 | Hand-written WebSocket | Confirmed 2026-10-29 |
| D3 | Testnet | Base Sepolia | A testnet of another Layer 2 | Confirmed 2026-10-29 |
| D4 | Hub API and relay | `hub-api`: TypeScript (Hono or Fastify) + viem, in `packages/hub-api`. `relay`: Node.js + `ws`, scaled per section 3.5 | Symfony following the company backend standard; Cloudflare Tunnel, libp2p or WebRTC instead of a relay | Confirmed 2026-10-29. ERC-4337 smart wallets (D5) need ERC-1271/6492 signature checks, which viem documents and no maintained PHP library offers; one language across relay, map servers, indexer and Hub. Alternatives rejected for cost, terms of service or missing Colyseus support (see `docs/research/2026-10-29-connection-scaling.md`). |
| D5 | Embedded wallet | Choose before Phase 2 (Privy, thirdweb, Coinbase Smart Wallet...) | — | Open until Phase 2 |
| D6 | Licence | MIT | AGPL-3.0, Apache-2.0 | Confirmed 2026-10-29. The original default was AGPL-3.0. P1 and P3 already stop cheating at the contract layer, so forcing modified servers to publish their code adds no protection, and MIT is easier for contributors. |
| D7 | Project name | `linked-realms` | — | Confirmed 2026-10-29 |
| D8 | Mine hash function | `keccak256` (cheapest to check on-chain) | SHA-256 like Bitcoin | Confirmed 2026-10-29 |
| D9 | Issuance parameters | 60 seconds per round, 50 `GOLD` per round, halved every 210,000 rounds, 21 million maximum; initial target calibrated in step 1B | Custom | Confirmed 2026-10-29 |
| D10 | Where mining runs | Inside the map server on the player's machine | Also a browser version (much slower) | Confirmed 2026-10-29 |

Also decided on 2026-10-29: Node.js 26 LTS; the repo is public from day one; all repository content is in English.

## 11. Working with Claude Code

- At the start of each phase or step: present a detailed plan and wait for approval before writing code.
- At the end of each task: run the relevant tests; mark it done only when the tests are green.
- The project owner decides every merge. Do not merge into `main` yourself, and do not push to the remote unless asked.
- When a rule or requirement is unclear: ask instead of guessing, then record the decision in `docs/decisions/`.
- Do not deploy to mainnet, do not commit secrets.
- Before adding a large library or a new external service: ask first.

## 12. Progress

- [x] Phase 0 – Foundations
- [ ] Phase 1 – Stage 1
  - [x] 1A – Land and characters
  - [x] 1B – Mine
  - [x] 1C – Connectivity and travel between lands
- [ ] Phase 2 – Open source and testing
- [ ] Phase 3 – Mainnet preparation

### Log

<!-- Claude Code records the date and the completed work here, newest first. -->

- 2026-10-29: Phase 1C built on branch `phase-1c/connectivity` (plan: `docs/plans/phase-1c-connectivity.md`, decisions: ADR 0004; the project owner waived the per-step approval gate for this run). `packages/hub-api` (Hono, PostgreSQL via `pg`, PGlite in tests): SIWE sign-in, Delegations signed by the Land owner (EIP-712, checked against `Land.ownerOf`), the Directory with online status read from the relay, Travel tickets (EIP-712, 60 s, adjacency checked from on-chain coordinates), abuse reports and admin hiding. `packages/relay` (Node.js + `ws`): one outbound link per Map server proven with the Mining key, Player HTTP and WebSockets multiplexed over it, per-Land and per-session counters, bounded buffers, and a k6 load test (200 Players, about 2,900 messages/s in and 5,800/s out, p95 202 ms on one laptop). Map servers verify tickets offline and spawn Characters at the arrival Gate; Gates are 2 tiles in the middle of each edge, stored in the map. The client signs in, lists the Directory, enters Lands through the relay, travels through Gates and draws them. One `Dockerfile` and a `world` compose profile run anvil, `hub-api`, the relay and three Map servers in three containers. Verified: `pnpm test` (332), `forge test` (41), Slither 0 findings; `pnpm e2e:world` passed (a Player walks from Land 1 through the east Gate into Land 2 and arrives one tile inside its west Gate; stopping `map-1` shows Land 1 offline after 1.5 s and online again 1.8 s after restart); in the browser a Player signed in, entered Land 1 through the relay, walked to Land 2 and back, and saw "No Land to the north" at an edge with no neighbour. The browser check found that the first build offered "Register" only inside the Land, which the relay refuses until the Land is registered; registration moved to the Land owner's panel (paste the Mining key address the Map server prints), and a fresh Map server container for Land 5 was registered that way, came online, and its owner switched mining on and off through the relay.
- 2026-10-29: Phase 1B built on branch `phase-1b/mine` (plan: `docs/plans/phase-1b-mine.md`, decisions: ADR 0003). Contracts `GoldToken` (capped at 21 million, only `GoldMine` mints) and `GoldMine` (Rounds, Solution check, Land check, halving, Retarget). `packages/miner` (worker threads, `hash-wasm` keccak256, 1 thread by default, polls the Round each second, submits with the Mining key); the Map server's owner-only mining switch with status shown to everyone on the Land; the client's `GOLD` balance, Rounds won and mining controls; the indexer's `round_won` and `retarget` tables. Initial Target calibrated at 3.2 million hashes per second per thread on the reference machine. The simulation test (`GoldMine.simulation.t.sol`) shows Round time returning to 60 s after hash rate rises 4× and falls to half. Verified: `forge test` (41), Slither 0 findings, `pnpm test` (176). On anvil with 5-second Rounds and a Retarget every 10 Rounds, `e2e:mining` ran two Map servers for two Lands mining together: 50 of 50 Rounds were won, each reward went to the owner of the Land whose Map server submitted it, both `GOLD` balances equal their summed rewards, and mean Round time per Retarget window went 1.0 → 2.3 → 6.6 → 6.4 s against the intended 5 s. The run found and fixed a miner defect: right after a win, a pre-flight `eth_call` sees `RoundAlreadyWonInThisBlock` and the miner dropped good Solutions (on an automining anvil the Mine stalled). In the browser, the Land owner switched mining on, won Rounds and saw `GOLD` and the Rounds won; a visitor saw the mining status without the controls.
- 2026-10-29: Phase 1A built on branch `phase-1a/land-and-characters` (plan: `docs/plans/phase-1a-land-and-characters.md`, decisions: ADR 0002). Contracts `PlayerRegistry` and soulbound `Land` (owner's decision) with spiral coordinates; rules reach the contracts through generated `Rules.sol` and cross-check vectors (P9). `indexer` (Ponder 0.18), `map-server` (Colyseus 0.18, authoritative 20 Hz movement, signed join message checked against the chain) and `client` (Phaser 4, dev wallet on anvil, Land map validated per P6). Verified: `forge test` (19), Slither 0 findings, `pnpm test` (101); on anvil two browser Players each created a Character with 4 stats equal to 1, received Lands 11 and 12, entered Land 1, saw each other and walked; the Mine blocks movement.
- 2026-10-29: Phase 0 built on branch `phase-0/foundations`: monorepo (Node.js 26, pnpm 11.3, Turborepo, TypeScript 6.0, ESLint, Prettier, Vitest), `contracts/` (Foundry 1.8.6, OpenZeppelin 5.6.1), `compose.yaml` (PostgreSQL 18.6, anvil), `packages/shared` rules, CI, ADR 0001. Verified locally: `pnpm test`, `forge test`, Slither and `docker compose up -d` are green. CI (`typescript`, `contracts`) is green on GitHub; secret scanning, push protection and `main` branch protection (PR required, both checks required, no force-push) are on. Phase 0 is done once the project owner merges PR #1.
- 2026-10-29: Section 10 confirmed (D1–D4, D6–D10; D5 before Phase 2); connection scaling rules added as section 3.5. PLAN.md and CLAUDE.md translated to English; `CONTEXT.md` glossary added.
