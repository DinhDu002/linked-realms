# PLAN.md — Execution plan for `linked-realms`

> `linked-realms` is a working name and can be changed at any time.
> This document is for both humans and Claude Code. **Claude Code:** read the whole file before starting, follow the phases in order, and update section 12 (Progress) after every completed task.

## 0. How to use this document

1. Put `PLAN.md` and `CLAUDE.md` at the root of an empty repo.
2. Read and settle section 10 (Decisions to confirm). If you choose something other than the default, edit this file directly.
3. Open Claude Code in the repo folder and ask: "Read PLAN.md, present a detailed plan for Phase 0, and wait for my approval before doing anything."
4. Work on one phase at a time. Move to the next phase only when the current one meets every "Done when" criterion.

## 1. Product vision

- Each player hosts their own server, and each server is one Land. Lands join into one shared world through a service the company operates, the **Hub**. The Hub only connects Lands and lets Characters and NPCs travel between them.
- Each Player plays **one main Character**, whose key stays in the Player's **Shell**. A Character can create NPCs, driven by AI models, to work for it.
- Each Land makes its own rules and its own interface, and its owner is responsible for it.
- **Gold** is the game's money. It is mined by Proof of Work on the game's own chain, like Bitcoin. Every Land runs a Node, and the Mines that Land owners switch on compete to seal each Block.
- **Stage 1** has Lands that anyone can host for free, Characters that walk between them, and Gold that is mined on the chain and sent between Characters.
- Open source. **The project owner decides** which changes are merged into the main version.
- Ideas beyond stage 1 are in section 7.

## 2. Invariant principles

Every design and every line of code must follow the principles below. If a request conflicts with them, **stop and ask**. Only the project owner may edit this section. The project owner approved this version on 2026-10-29 (ADR 0006–0008).

- **P1 – Do not trust Map servers.** Gold is decided only by chain rules that every Node checks. What happens inside a Land is that Land's business; a Land cannot change another Land or the chain.
- **P2 – No server holds a Player's key.** Players' keys stay in the Shell. A server holds only its Map server key and the keys of its owner's NPCs.
- **P3 – Every Node checks every Block itself:** Proof of Work, signatures and rules. Nothing is accepted on anyone's word.
- **P4 – Gold is issued on a fixed schedule:** a Block reward halved every 2,100,000 Blocks, then 0.3125 GOLD per Block forever. No premine, no other way to create Gold.
- **P5 – Mining is voluntary.** A Mine runs only when its owner turns it on, has a CPU limit, and shows clearly that it is mining.
- **P6 – A Land's code runs only in an isolated frame.** The Shell never runs Land code in its own page and shows every signing request outside the frame.
- **P7 – Test network only.** It may be reset with notice; Gold has no value until Phase 3 and a written decision.
- **P8 – The chain holds only money.** Lands, names, items, stats and heavy data live with the Hub or the Lands.
- **P9 – Chain rules have one source:** `crates/core`, tested against fixed vectors and used by the Node, the Mine and the Shell.
- **P10 – Design for extension.** Transactions and addresses carry a version and a scheme id, so rules and signature schemes can change through network upgrades.

## 3. Architecture

The target architecture follows ADR 0006 (own chain), ADR 0007 (the world off the chain) and ADR 0008 (Shell, open Lands, NPCs).

### 3.1 Components

| Component | Operated by | Role |
|---|---|---|
| `crates/core` | — | Chain rules, transaction encoding, hashing, ML-DSA signing, addresses; built natively and to WASM |
| `crates/node` | Player (and the company) | Node: checks, stores and relays Blocks and transactions, JSON-RPC; runs the Mines |
| `packages/shell` | Static page, anyone can host it | Holds the Player's key, signs, shows each Land's UI in an isolated frame |
| `packages/map-server` | Player | Reference Land kit: real-time simulation of a Land |
| `packages/client` | Player's browser, inside the Shell's frame | Reference Land kit: the Land's UI |
| `packages/hub-api` | Company | Land registration and cells, Directory, names, Travel tickets, abuse reports and removal |
| `packages/relay` | Company | Serves each Land on its own subdomain and forwards its connections |
| `packages/shared` | — | TypeScript types shared by the reference kit and the Hub |
| Checkpoint signer, seed nodes, Public node, archive | Company | Separate services built on `crates/node` (ADR 0006) |

### 3.2 Repo structure

```
linked-realms/
├── CLAUDE.md
├── CONTEXT.md            # domain glossary
├── PLAN.md
├── Cargo.toml            # Cargo workspace for crates/
├── rust-toolchain.toml
├── compose.yaml          # local dev environment
├── .github/workflows/    # CI
├── crates/
│   ├── core/
│   └── node/
├── packages/
│   ├── shared/
│   ├── shell/
│   ├── hub-api/
│   ├── map-server/
│   ├── client/
│   └── relay/
├── maps/                 # sample lands (Tiled JSON)
└── docs/
    └── decisions/        # ADRs: one file per architecture decision
```

### 3.3 Where data lives

| Data | Stored in | Why |
|---|---|---|
| Gold balances, nonces, public keys | Chain | Money (P1, P8) |
| Lands, cells, owners, Delegations, online status | Hub (PostgreSQL) | The map of the world (ADR 0007) |
| Character names | Hub | Free, not unique |
| Land items, Quests, Character stats, positions, the Land's design | The Land's own server | Up to the Land (P1, P8) |
| A Player's key | The Shell, encrypted in the browser | P2 |
| Map server key, NPC keys | The Land owner's server | P2 |
| AI API key | The NPC owner's server | ADR 0008 |

### 3.4 Main flows

- **Creating a Character:** the Shell generates 24 words, derives an ML-DSA-44 key and its address, and stores the key encrypted with the Player's password. Nothing reaches the chain until the address's first transaction.
- **Registering a Land:** the Land owner runs the Docker stack, which creates a Map server key. The owner signs a Delegation naming that key in the Shell. The Map server connects outward to `relay`, so the owner opens no port. `hub-api` checks that the Map server is running and that the rules in section 5.1 hold, then gives the Land the next spiral cell in the Directory.
- **Travelling to another Land:** the Shell asks the Hub for a Travel ticket with a signed challenge. The Hub signs a short-lived ticket for the adjacent Land. Land B checks the ticket and the challenge at arrival, then the Shell loads Land B's UI in a frame on B's subdomain.
- **Mining Gold:**
  1. A Mine that its owner switched on takes a Block template from its local Node.
  2. It tries nonces, hashing the Block header with RandomX, until a hash falls below the Target.
  3. The Node broadcasts the sealed Block. Every Node checks the Proof of Work, the signatures and the rules (P3) before passing it on.
  4. The Block reward and the fees go to the address the Mine mines for.
  5. The Target is retargeted after every Block, and the Checkpoint signer signs a Checkpoint every 10 Blocks.
- **Paying inside a Land:** the Land's UI asks the Shell to sign a payment (amount, recipient, memo). The Player approves it in the Shell, and the transaction goes to a Node. Once it is in a Block, the Land sees it through its Node and delivers the item.
- **An NPC doing a Quest:** the NPC runner on the owner's server gets a Travel ticket and arrives declaring that an AI drives it. The model reads the actions the Land publishes and proposes one; the runner checks it against the owner's limits and signs. The Land pays the reward to the payout address the NPC names, which is its owner's by default.

### 3.5 Connection scaling rules (D4)

Target: about 1,000 concurrent players for testnet and Phase 2, with a protocol that reaches 100,000+ without a rewrite. Long-lived connections land on `relay`, not on `hub-api`. Evidence and sources: `docs/research/2026-10-29-connection-scaling.md`.

1. Every Map server link and every client connection names its Land (its subdomain), so relay nodes can later be routed per Land.
2. The relay forwards each Land's HTTP and WebSocket traffic, whatever protocol the Land speaks (ADR 0008).
3. Entering a Land requires a Travel ticket: the Map server verifies it offline and only then reserves a seat.
4. Online status comes from the Map server's live connection to the relay, not from HTTP heartbeats to `hub-api`.
5. Directory responses are cacheable (`s-maxage` + `stale-while-revalidate`).
6. The relay counts bytes and messages per session, so any decision to move traffic off the relay (for example WebRTC) is based on measured data.
7. WebSocket compression is off, frame size is limited, and slow clients get bounded buffering.
8. A load-test harness with a non-JavaScript client exists from the first relay version.

Tiers: up to ~1,000 players → one Node.js `ws` relay process; ~10,000 → several relay nodes routed per Land, on uWebSockets.js; 100,000+ → a sharded relay fleet whose engine is chosen by load test (Go if Node.js falls short).

## 4. Default technology stack

Items marked (*) need confirmation in section 10.

- **Monorepo:** pnpm workspaces + Turborepo, TypeScript (strict), Node.js 26 (current LTS) for the TypeScript packages; a Cargo workspace in `crates/`, with the Rust version pinned in `rust-toolchain.toml`.
- **Testing:** Vitest (TypeScript); `cargo test`, `cargo clippy` and `cargo fmt --check` (Rust), with fixed test vectors: NIST vectors for ML-DSA and the official RandomX vectors.
- **Chain (ADR 0006):** Rust. `sha3` (keccak256); `fips204` for ML-DSA-44, cross-checked against RustCrypto `ml-dsa`; RandomX v2.0.1 through a small FFI binding of our own (CMake and a C++ compiler at build time); `redb` storage; `jsonrpsee` JSON-RPC; a hand-written Bitcoin-like TCP P2P protocol behind an interface. `crates/core` is built to WASM with `wasm-bindgen`.
- **Shell:** a static TypeScript page using the WASM build of `crates/core`.
- **Reference Land kit:** Map server on Node.js with WebSocket + Protocol Buffers (D2); client in Phaser 4, top-down 2D, in the browser (D1).
- **Maps:** made with the Tiled Map Editor, exported as JSON.
- **Hub API:** TypeScript on Node.js (Hono) + PostgreSQL (D4). **Relay:** Node.js + `ws`, moving to uWebSockets.js and then a sharded fleet as load grows (section 3.5).
- **NPCs:** a Claude API adapter first, then an OpenAI-compatible adapter (D15).
- **Infrastructure:** Docker, `compose.yaml` (`docker compose` v2 command, no `version` key), PostgreSQL `-alpine` images, every image pinned to a version (no `:latest`).

## 5. Rules for stage 1

The values below are defaults. Chain rules live in `crates/core` (P9) and change only through network upgrades decided by the project owner. Hub rules live in `hub-api` and can be tuned.

### 5.1 World

- A Character is an ML-DSA-44 key and its address, created in the Shell from 24 words. Its name is kept by the Hub: free, at most 32 characters, not unique.
- A Character registers at most one Land with the Hub, for free. A Land is never transferred.
- Lands receive cells along a spiral from the centre of the world. A Land gets its cell only once its Map server is running (reachable, with a valid Delegation). At most 3 new Lands per network address per day. A Land offline for 30 days in a row loses its cell and gets a new one at the edge of the spiral when it returns.
- Each Land has Gates on its four edges that lead to the adjacent cells. How large a Land is inside, and what it holds, is up to its owner; the reference kit's Land is empty and flat, 64×64 tiles.
- Characters have no shared stats; each Land sets its own (ADR 0007).
- In the reference kit, visitors walk and look. Other Lands set their own rules.

### 5.2 Chain

- **Proof of Work (D8):** RandomX v2 over the Block header. keccak256 for transaction ids, Merkle roots and addresses.
- **Block time (D9):** 60 seconds. **Retarget:** LWMA after every Block. **Initial Target:** measured in step 2C so that one Mine thread on the reference machine seals a Block in about 60 seconds; record the value in an ADR.
- **Reward (D9):** 5 `GOLD` per Block, halved every 2,100,000 Blocks (about 4 years). After four halvings (about 16 years, 19,687,500 `GOLD`), 0.3125 `GOLD` per Block forever. 8 decimals. No premine, no developer fund.
- **Fees:** a per-size fee auction with a minimum relay fee; fees go with the Block reward to the address the sealing Mine names. A Block holds at most 1 MB. A transfer may carry a memo of up to 80 bytes.
- **Signatures (D12):** ML-DSA-44 with a scheme id in addresses and transactions. A key-rotation transaction. The public key travels in an address's first transaction and is then kept on chain.
- **Checkpoints:** every 10 Blocks, signed by the Checkpoint signer. No Node accepts a history that changes anything before a Checkpoint.
- **Nodes:** pruned by default, starting from a Checkpoint snapshot; Block headers carry a state root.

### 5.3 Mine

- Each Land has one Mine. It runs beside the Land's Node on the Land owner's server and mines for the Land owner's address. No Land, no Mine: a Player without a Land gets Gold only by being sent some (decided by the project owner on 2026-10-30; this replaces ADR 0006 point 11, and ADR 0014 records it).
- The Land owner switches the Mine on or off and picks its threads in their own Land, signing through the Shell's prompt; everyone in the Land sees when it mines and when it wins a Block.
- **Voluntary mining (P5):** off at every start. When on, it uses 1 CPU thread unless the owner picks more, and it shows clearly that it is mining.
- Fast mode when the machine has the memory (about 2 GB), light mode otherwise.

### 5.4 Shell

- The key comes from 24 words, asked for only on the Shell's own setup page. It is stored encrypted with a password the Player sets, and the Shell locks itself after a period of inactivity.
- Each Land's UI runs in a cross-origin iframe on the Land's subdomain. Every signing request is shown in the Shell, outside the frame, with the amount, the recipient and the memo in plain words.

### 5.5 NPCs

- An NPC's key stays on its owner's server. The AI never sees it: the NPC runner checks each proposed action against the owner's limits, such as Gold per day and allowed Lands, and only then signs.
- An NPC declares at arrival that an AI drives it. It names its payout address, which is its owner's by default.

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

### Phase 1 – Stage 1 on the EVM design (superseded)

Built on Solidity contracts; superseded on 2026-10-29 by ADR 0006–0008. Step 2B deletes the contracts and the indexer. Stage 1's Done-when criterion moves to step 2C.

#### 1A – Land and characters

- [x] `PlayerRegistry` contract (UUPS): one character per wallet, non-transferable; stats stored as key–value pairs, all initialised to 1.
- [x] `Land` contract (ERC-721, UUPS): one land per wallet; spiral coordinates assigned automatically; stores the hash of the land design.
- [x] `indexer` (Ponder) reads events from both contracts into Postgres.
- [x] `map-server`: a Colyseus room for one empty 64×64 land; several people join, see each other and walk around.
- [x] `client` (Phaser): create a character by signing a transaction, view stats, walk around.

**Done when:** on anvil, a player creates a character with 4 stats equal to 1, receives a land and walks around; two clients on the same land see each other.

#### 1B – Mine

- [x] `GoldToken` contract (ERC-20 `GOLD`): 21 million cap, only `GoldMine` can mint.
- [x] `GoldMine` contract: rounds, challenges, solution checks, checking that the reward wallet owns a land, rewards, halving, retargeting (ADR 0003).
- [x] `packages/miner`: worker thread that tries nonces, CPU limit, watches events to stop when the round changes, submits solutions with the mining key.
- [x] `map-server`: mining on/off switch for the land owner, showing hash rate and the current round.
- [x] `client`: shows the mine on the land, the `GOLD` balance, and the history of rounds won.
- [x] Simulation script: raise and lower the total hash rate, and check that round time converges to the intended value.

**Done when:** two map servers mine together on anvil; after a few retargets, round time converges to about 60 seconds; rewards go to the correct land owner wallet; every mine test passes.

#### 1C – Connectivity and travel between lands

- [x] `hub-api` (TypeScript, D4): register map servers using the land owner's delegation signature, directory, online status, SIWE sign-in, abuse reports and removal from the directory.
- [x] `relay`: map servers connect outward to the relay; clients enter a land through the relay; follows the rules in section 3.5.
- [x] Gates on the four edges of a land lead to the adjacent land according to on-chain coordinates; travel tickets are signed and short-lived.

**Done when:** three map servers run in three separate containers; a player walks through a gate from land A to land B; shutting down A makes the directory show it as offline.

### Phase 2 – Own chain, open source and testing (test network)

**Goal:** people outside the team host their own Land, mine Gold on the game's own chain and play reliably.

#### 2A – Self-hosting, wallet and dashboard (EVM design)

- [x] Docker image that runs the map server and miner with one command; self-hosting guide.
- Moved to Phase 0 because the repo is public from day one: settling the licence (D6), making the repo public, `CONTRIBUTING.md` stating that the project owner reviews every PR.
- [x] Embedded wallet + paymaster (D5): Passkey wallet + CDP Paymaster behind `hub-api` (ADR 0005). Superseded by the Shell (ADR 0008) and removed in 2B; the CDP spike and the Base Sepolia deployment are no longer needed.
- [x] Dashboard: number of lands online, number of mines mining, estimated hash rate, round time, winner distribution. Reads the contracts; rebuilt in 2C.

#### 2B – World without the chain (ADR 0007, 0008)

- [x] Cargo workspace `crates/` with `rust-toolchain.toml`; CI runs `cargo fmt --check`, `cargo clippy` and `cargo test`.
- [x] `crates/core`, first part: 24-word seed phrase, ML-DSA-44 keys and signatures (`fips204`, cross-checked with `ml-dsa` against NIST vectors), addresses with a scheme id; WASM build with `wasm-bindgen`.
- [x] `packages/shell`: create and restore a key, password encryption, auto-lock, sign in to the Hub, show a Land's UI in a cross-origin iframe, signing prompts outside the frame.
- [x] `hub-api`: Land registration signed with the Character key, spiral cells and the rules in section 5.1, names, Travel tickets and arrival handoff for ML-DSA identities (with the "driven by AI" field); SIWE, EIP-712 and `POST /aa` removed.
- [x] `relay`: protocol-neutral, each Land on its own subdomain; Land owners may use their own domain.
- [x] Reference Land kit: `map-server` and `client` use the Shell and the Hub; the game protocol moves from Colyseus to WebSocket + Protocol Buffers (D2); mining is hidden until 2C.
- [x] Specify the mandatory protocols in `docs/`: Shell ↔ Land UI API, arrival handoff, Map server ↔ Hub and relay, the Gate travel message (Map server ↔ Node follows in 2C).
- [x] Delete `contracts/`, `packages/indexer`, `packages/miner`, the Passkey wallet and the CDP proxy; remove Foundry and Slither from CI.
- [x] `packages/shared/src/rules`: delete the mining and sponsorship rules and the generated contract cross-checks; chain rules are rewritten in `crates/core` in 2C (P9). The spiral and the other Hub and kit rules stay in TypeScript.

**Done when:** two people on two machines run their own Lands, register them with the Hub without any Gold and walk through a Gate into each other's Land; a test shows that a Land's UI cannot read the Shell's keys or sign without the Player's approval.

#### 2C – The chain (ADR 0006)

- [ ] `crates/core`: transfers with a memo, key rotation, the Block format with a state root, issuance with halvings and the tail reward, LWMA Retarget, fee and size rules, the RandomX v2 binding (v2.0.1 pinned) with the official vectors on x86 and ARM.
- [ ] `crates/node`: Block and transaction checks, a mempool with the fee auction and minimum relay fee, `redb` storage, pruning from Checkpoint snapshots, TCP P2P behind an interface, JSON-RPC (`jsonrpsee`), Checkpoint checks.
- [ ] The Mine: one per Land, switched on and off by the Land owner in the Land, CPU limit, fast or light mode by available memory, rewards to the Land owner's address; the effect everyone in the Land sees when it wins a Block.
- [ ] Company services: Checkpoint signer, seed nodes, Public node, archive.
- [ ] Shell: balance, send Gold with a memo, key rotation, prompts for payments a Land asks for.
- [ ] Docker stack: Map server, Node (on by default, can be turned off) and Mine (off); self-hosting guide updated; Map server ↔ Node protocol specified.
- [ ] Dashboard rebuilt on the Public node and the Hub.
- [ ] Simulation: hash rate rises and falls and Block time returns to about 60 seconds; Checkpoints stop deeper rewrites.

**Done when (Stage 1):** on the test network, at least 3 Players on 3 different machines each host a Land, run a Mine that wins Blocks, send Gold to each other through the Shell, and walk into each other's Lands.

#### 2D – Economy in the reference Land kit

- [ ] A Land item shop: buying is a Gold payment with a memo; the Land keeps the item for the buyer.
- [ ] Quests whose rewards a treasurer on the Land owner's server pays in Gold: a minimal payout component that holds an NPC key and pays within limits the owner sets, with no AI (2E grows it into the NPC runner).

**Done when:** a visitor buys a Land item in another Land and still has it on the next visit; a finished Quest pays its reward to the visitor's address.

#### 2E – NPCs (ADR 0008)

- [ ] NPC runner on the owner's server, built on 2D's payout component: holds the NPC key, takes work from its owner, checks the owner's limits before signing, pays earnings to the owner.
- [ ] Reference NPC action standard for Lands that welcome NPCs; Claude API adapter, then an OpenAI-compatible adapter.
- [ ] Arrival with the "driven by AI" field; the reference kit shows it.

**Done when:** an NPC created by one Player travels to another Player's Land, finishes a Quest there, and the reward reaches its owner; a test Land that tells the NPC to send its Gold away does not get past the owner's limits.

#### 2F – Audit before Phase 3

- [ ] Independent security audit of `crates/core` and `crates/node`: consensus, ML-DSA, the RandomX binding, P2P.

**Done when:** the audit report is published and every finding is fixed or accepted by the project owner in writing.

**Phase 2 is done when:** at least 10 Lands hosted by people outside the team stay connected reliably for one week.

### Phase 3 – Mainnet preparation (only with a written decision)

- [ ] Legal review before Gold has real value: a currency, mining, player-hosted content, AI-driven NPCs (EU AI Act).
- [ ] Launch plan for the main network: genesis without premine, handling of the Checkpoint signer's key, seed nodes.
- [ ] Revisit the issuance parameters using test network data.

## 7. Ideas beyond stage 1

Not part of stage 1. The project owner will decide the order.

| Idea | Design notes |
|---|---|
| Spend gold to build and upgrade | Inside a Land, the Land's own business; payments are Gold transfers on chain |
| Shared character stats | Only with a rule the chain can check, for example burning Gold, added by a network upgrade (ADR 0007) |
| Upgrade the mine | If upgrades multiply the reward, mining is no longer pure Proof of Work; the issuance schedule must be redesigned (P4) |
| Escrow for Quests and NPC rentals | Needs a new transaction type: Gold locked until both sides agree or a deadline passes |
| Owner statement for NPCs | A statement the owner signs and the NPC carries, so Lands can show whose NPC it is (ADR 0007) |
| Name moderation | Deferred by the project owner; add later if needed |
| Passkey unlock for the Shell | Next to the password, not instead of it |
| Troops and conquering land | Needs a new design: Lands live with the Hub and the chain holds only money (P8) |
| libp2p | Can replace the hand-written P2P layer behind its interface |

## 8. Testing and quality

- Every package and crate has tests. CI runs lint, `pnpm test`, `cargo fmt --check`, `cargo clippy` and `cargo test` on every PR.
- **Fixed vectors (P9):** NIST vectors for ML-DSA-44, with `fips204` and `ml-dsa` agreeing; the official RandomX v2 vectors on x86 and ARM; transaction and address encodings shared by the Node, the Mine and the Shell's WASM build.
- **Chain rules (unit, property):**
  - Invalid Proof of Work, a bad signature, a wrong nonce or a spent balance are rejected.
  - A transaction signed for another scheme id or another network is rejected.
  - Retarget follows the LWMA formula; a simulation brings Block time back to about 60 seconds after the hash rate rises and falls.
  - Halvings happen at the right heights, the tail reward starts after the fourth, and issuance matches the schedule exactly.
  - A Block over 1 MB or a memo over 80 bytes is rejected; fees go to the sealing Mine's reward address.
  - A rewrite that changes anything before a Checkpoint is rejected.
- **Hub:** one Land per Character; no duplicate cells; a cell only for a running Map server; at most 3 new Lands per network address per day; a Land offline 30 days loses its cell.
- **Shell:** a Land's frame cannot read the key; nothing is signed without the Player's approval; the prompt shows the amount, the recipient and the memo.
- **"Cheating server" tests:** a modified Map server or Node cannot create Gold or spend someone else's.
- **End-to-end:** compose brings up three Nodes, the Hub, the relay and two Lands; scenario: create a Character in the Shell → register a Land → turn a Mine on → win a Block → send Gold → walk through a Gate into the other Land.

## 9. Security and risks

| Risk | Mitigation |
|---|---|
| Rented hash power takes over a small chain (51% attack) | Checkpoints every 10 Blocks limit rewrites; RandomX v2 favours CPUs; the test network has no value (P7) |
| The Checkpoint signer's key leaks | A separate company service with its own key; the key changes only by network upgrade; key handling is a Phase 3 item |
| Bugs in new consensus code, ML-DSA crates or the RandomX binding | Pinned versions; NIST and RandomX vectors on x86 and ARM; two ML-DSA crates cross-checked; independent audit before Phase 3 |
| Players with powerful machines win most Blocks | Accepted, as in Bitcoin; track the winner distribution on the dashboard |
| Players write their own mining tools or mine elsewhere | Cannot be prevented with open source; rewards still depend only on hash rate |
| Players' machines run hot; the software is flagged as coin-mining malware | P5: voluntary mining, off by default, CPU limit, clearly shown |
| Land spam on the map | Hub rules in section 5.1: a cell only for a running Map server, 3 new Lands per network address per day, cells freed after 30 days offline |
| A malicious Land's UI tricks visitors | P6: isolated frame; the Shell's own prompt is the only place to approve a signature |
| A lost seed phrase and password | No recovery; the Shell says so at setup |
| Prompt injection against AI-driven NPCs | The AI never sees the key; the NPC runner enforces the owner's limits; earnings go straight to the owner (ADR 0008) |
| A Land does not pay a Quest or loses bought items | Land owners are responsible for their Lands; the chain proves the payment; escrow is a later idea |
| The Hub is a central point | It holds no Players' keys and signs no Checkpoints; if it is down, travel stops but the chain and the Lands keep running |
| Leaked private keys or secrets | P2; `.env.example`; secret scanning in CI |
| Rule-breaking content on player-hosted Lands | Report and remove from the Hub's Directory; terms of use |
| NPCs not disclosed as AI (EU AI Act Article 50) | The "driven by AI" field at arrival; legal review in Phase 3 |
| Legal exposure once Gold has real value | P7; legal review before the main network |

## 10. Decisions to confirm

| # | Decision | Choice | Alternatives | Status |
|---|---|---|---|---|
| D1 | Client | Phaser 4 in the browser | Godot 4, Unity | Confirmed 2026-10-29. The original default was Phaser 3; Phaser 4 is the current major version. |
| D2 | Map server networking | Reference Land kit: WebSocket + Protocol Buffers, not mandatory for other Lands (ADR 0008) | Colyseus 0.18 (used until step 2B) | Replaced 2026-10-29. Colyseus's wire format is undocumented and its server is TypeScript-only, so Lands in other languages could not speak it. |
| D3 | Test network | The game's own chain, reset with notice (ADR 0006) | Base Sepolia | Replaced 2026-10-29 |
| D4 | Hub API and relay | `hub-api`: TypeScript (Hono) in `packages/hub-api`. `relay`: Node.js + `ws`, scaled per section 3.5 | Symfony following the company backend standard; Cloudflare Tunnel, libp2p or WebRTC instead of a relay | Confirmed 2026-10-29. One language across relay, reference Map server and Hub. viem and the ERC-1271/6492 checks go away with the contracts (ADR 0007). Alternatives rejected for cost or terms of service (see `docs/research/2026-10-29-connection-scaling.md`). |
| D5 | Players' keys | The Shell: keys from 24 words, encrypted with a password, Land UIs in isolated frames (ADR 0008) | Passkey wallet + CDP Paymaster (ADR 0005, built in 2A) | Replaced 2026-10-29 |
| D6 | Licence | MIT | AGPL-3.0, Apache-2.0 | Confirmed 2026-10-29. The original default was AGPL-3.0. Chain rules checked by every Node already stop cheating, so forcing modified servers to publish their code adds no protection, and MIT is easier for contributors. |
| D7 | Project name | `linked-realms` | — | Confirmed 2026-10-29 |
| D8 | Proof-of-Work hash | RandomX v2 (v2.0.1, `RANDOMX_FLAG_V2`) from the first Block (ADR 0006) | `keccak256`; RandomX v1 through `randomx-rs` | Replaced 2026-10-29 |
| D9 | Issuance parameters | 60-second Blocks, LWMA after every Block, 5 `GOLD` per Block halved every 2,100,000 Blocks, then 0.3125 `GOLD` per Block forever; 8 decimals; no premine (ADR 0006) | 50 `GOLD` halved every 210,000 Rounds, 21 million cap | Replaced 2026-10-29 |
| D10 | Where mining runs | Mines beside a Node on the Player's own server, any number (ADR 0006) | Inside the Map server; a browser version | Replaced 2026-10-29 |
| D11 | Chain implementation | Written from scratch in Rust, `crates/` in this repo (ADR 0006) | Fork btcd or Bitcoin Core; TypeScript; Substrate | Confirmed 2026-10-29 |
| D12 | Signatures | ML-DSA-44 (FIPS 204) with a scheme id and key rotation (ADR 0006) | secp256k1 ECDSA | Confirmed 2026-10-29 |
| D13 | Where the world lives | Lands and names with the Hub; items, Quests and stats with each Land; NPCs unrecorded (ADR 0007) | Lands on chain | Confirmed 2026-10-29 |
| D14 | Land freedom | Own rules and UI per Land; a few mandatory protocols, the rest reference (ADR 0008) | One shared game server for every Land | Confirmed 2026-10-29 |
| D15 | NPC AI | Owner's own model and API key; Claude API adapter first, then OpenAI-compatible (ADR 0008) | A company-provided AI | Confirmed 2026-10-29 |

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
- [ ] Phase 1 – Stage 1 on the EVM design (superseded by ADR 0006–0008; its Done-when moves to 2C)
  - [x] 1A – Land and characters
  - [x] 1B – Mine
  - [x] 1C – Connectivity and travel between lands
- [ ] Phase 2 – Own chain, open source and testing
  - [x] 2A – Self-hosting, wallet and dashboard (EVM design)
  - [ ] 2B – World without the chain
  - [ ] 2C – The chain (plan approved on 2026-10-30: `docs/plans/phase-2c-the-chain.md`; items 1 to 3 of 27 built)
  - [ ] 2D – Economy in the reference Land kit
  - [ ] 2E – NPCs
  - [ ] 2F – Audit before Phase 3
- [ ] Phase 3 – Mainnet preparation

### Log

<!-- Claude Code records the date and the completed work here, newest first. -->

- 2026-10-30: Step 2C item 3 on branch `phase-2/2c-3-smt`: the state root in `crates/core` `smt`, a sparse Merkle tree of depth 256 keyed by `keccak256(address)` over the `SmtStore` trait, with an in-memory store for tests. Storage keeps one entry per node over two or more accounts and one per account alone in its subtree, split at the first differing bit when a second key arrives, and the entries depend only on the set of keys; a removal (for a Node undoing a Block) merges them back. `check_snapshot` builds the tree of a state snapshot in key order and compares the root. A naive full-tree reference checks inserts, updates and removals step by step. `chain.json` gains the state tree on chosen keys, a state root after every ledger step (28 steps, one more where an emptied account stays) and six state snapshot cases; a scratch JavaScript tree written from the plan's text (`@noble/hashes`, not kept) agreed with all 559 values. Measured on an Apple M5: a full Block's 795 changed accounts update the root in 38.6 ms with 100,000 accounts, at 2.44 stored entries per account, about 160 MB a day of state growth when keys are spread evenly; keys ground to share long prefixes raise it, about 1 GB a day at twenty extra shared bits each. ADR 0011 gains the state root and the growth bound, which waits for the project owner's confirmation; `docs/protocols/transactions.md` gains the state root.

- 2026-10-30: Step 2C item 2 on branch `phase-2/2c-2-tx`: transactions and accounts in `crates/core`. `tx::Tx` reads and writes the layout of the new mandatory `docs/protocols/transactions.md` (transfer with a memo of up to 80 bytes, key rotation, the public key only on the sender's first transaction), signs with the network id first in the signed bytes, and its id is the keccak256 of those bytes. `check_tx` and `apply_tx` run over the `StateView` and `State` traits, cheap checks first and the signature last, and write nothing on an error. `state::Account` has its 82-byte hashed form for the state root. A sender must already have an account (ADR 0011). `chain.json` gains a ledger of 27 steps replayed in order: every valid kind, every refusal (including a replay, the wrong network both ways, the old key after a rotation) and every format error, each asserted against its expected verdict, with a check that Gold is neither made nor lost.

- 2026-10-30: Step 2C item 1 on branch `phase-2/2c-1-core`: in `crates/core`, `codec::Reader` (big-endian fixed-width fields, refusing truncated and trailing bytes), `Address::to_bytes` and `Address::from_bytes` (the 34-byte payload), `params::ChainParams` with `TESTNET` (1) and `DEV` (2), `issuance::reward` (genesis at height 0 pays nothing, halvings from height 1, exactly 19,687,500 GOLD before the tail) and `merkle::tx_root` (an odd node moves up unchanged). New vectors in `crates/core/test-vectors/chain.json`; the `tx_root` and issuance values were also recomputed once by hand in JavaScript (`@noble/hashes`, a scratch script not kept in the repo), and item 10's Vitest makes that check permanent. ADR 0011 records the encodings, the network id in signed bytes, the transaction id and the issuance.

- 2026-10-30: The step 2C plan is approved. The project owner answered its 22 questions (recorded in the plan, "Answers of the project owner"). They chose the recommended option except for four: the state root is a sparse Merkle tree from the start (a new item 3, so 27 items); the seed node, Public node and archive run as a separate compose project on the carthings server, with the Checkpoint signer on a separate machine; "No Land, no Mine": one Mine per Land, mining for the Land owner, with no standalone Mine (section 5.3, the Mine item in 2C, `CONTEXT.md` and ADR 0006 point 11 are updated; ADR 0014 will record it); and no minimum for a transfer to a new address. The work keeps the order of section 6, 2C, one stacked PR per item. `CONTEXT.md` gains Account, the chain's record for one address. A review after the answers found that the state-growth estimate left out the tree's own entries: at worst about 140 to 200 MB a day, not 57 MB; the plan says so and the figure goes back to the project owner.

- 2026-10-30: Step 2C planned. `docs/plans/phase-2c-the-chain.md` was drafted for the project owner: encodings, issuance, the LWMA Retarget, the RandomX v2 binding (tag v2.0.1, commit aaafe71), `crates/node`, the Mine, the Map server and Node protocol, the Shell's chain features, company services, the Docker stack, the dashboard, the simulation, 26 PR-sized items and 22 questions. It records the owner's decisions of today: the Mine's switch lives in the Land, signed by the Land owner through the Shell's prompt; everyone in the Land sees a won Block; the work follows the order of section 6, 2C. An independent critique found 20 defects in the first draft (among them no network id in transaction signatures, LWMA overflow, a won Block attributed by address, and an unauthenticated Mine control path); all are fixed in the draft.

- 2026-10-30: Full screen. A "Full screen" button in the Shell's bar puts the whole Shell page in full screen (not the Land's frame, so the signing prompt stays in view, P6) and back; it is hidden where the browser has no full screen. iPhone Safari has none for pages (still missing in the WWDC26 Safari 27 notes), so on a touch screen without it the Shell tells the Player to add it to the Home Screen; `packages/shell/public/manifest.json` (`display: standalone`) opens it from there without Safari's bars, with its own storage, so the Character is restored there with the 24 words. Playwright covers the button and the manifest in Chromium, and the hint on an emulated touch screen; Firefox could not be started on this machine, so its run waits for CI. The owner chose to start step 2C next, which brings the Mine's on/off switch and the effect when a Mine wins a Block.

- 2026-10-30: Playing on phones. The Land UI showed no way to walk without a keyboard. On touch screens (CSS `pointer: coarse`) it now shows a pad in the lower left: a finger held on it and slid around walks the Character in 8 directions of 45°, with a dead zone in the middle (`padKeys` and `attachPad` in `packages/client/src/input.ts`); the pad's directions add to the keys. The pad listens to touch events, not pointer events: in Chromium, a Land frame made while a finger was still down (walking through a Gate) received the touches but never their pointer events, so the pad went dead after the first travel. The world e2e walks a Character through a Gate and back with real touches on an emulated Pixel 7, and checks that the pad stays hidden on a desktop. Hosting a Land still needs Docker on a computer.
- 2026-10-29: A Land from one command (ADR 0010), for the first try on two machines. The Hub's `GET /keys` also publishes the relay's URL (`RELAY_PUBLIC_URL`); the Map server reads the ticket signer and the relay from it when `HUB_TICKET_SIGNER` or `RELAY_URL` is unset, retrying with backoff while the Hub is unreachable, and the compose Map servers no longer set the signer. The Shell's "Your Land" shows one `docker run` line with the Character's address, the Hub and the image (`VITE_LAND_IMAGE`), with a Copy button; the line pastes the same into sh and PowerShell. `.github/workflows/image.yml` publishes `ghcr.io/dinhdu002/linked-realms-node` for amd64 and arm64 from `main` and `phase-2/2b-world`; the Dockerfile builds the WebAssembly core and the web pages on the build machine's platform. `docs/self-hosting.md` starts from the Shell's command; the README has a Play section for <https://play.linkedrealms.com>. Setup now shows its first choices only once its script is ready: on the public world a new player's first click could land before the WebAssembly core had loaded and do nothing.
- 2026-10-29: Step 2B item 10: own domains for Land owners (`map-server-hub-relay.md`, Land URLs). The Hub's `PUT /lands/:landId/domain` (session, the owner; 10 per minute) stores the name trimmed, in lowercase ASCII (IDNA) and without its trailing dot, refuses ports, wildcards, IP addresses and names without a dot, and requires the DNS TXT record `_linked-realms.<domain>` = `land=<landId>`; a domain moves to another Land only once its record no longer names the first. `LandInfo` has `domain`, and `url` uses it. `GET /lands?domain=` finds the Land, and `GET /tls/allowed?domain=` answers 200 only for the own domain of a visible Land with a cell. The sweep reads each record again once a day (50 per sweep), drops a domain its record no longer names, and keeps one whose DNS does not answer, asking again an hour later. The relay serves a Land at any host the Hub names, keeping each answer, failures included, for 30 seconds (at most 10,000 hosts), and answers other hosts with a 404 page without asking the Hub for names under `LAND_BASE_DOMAIN`. Its own routes answer on `RELAY_HOST` and on hosts with a port (how the Hub reaches it inside the operator's network), and `/online` and `/stats` refuse anything a proxy forwarded (`X-Forwarded-For` or `Forwarded`). The adversarial review found that the new catch-all let a client reach them by sending the relay's name as SNI with a Host no site matches; that was the third Caddyfile route to the same leak (after the `RELAY_HOST` path filter and the wildcard's port), so the fix is in the relay, not in a fourth Caddy rule. Before: `/stats` through Caddy answered 200 with the relay's counters; after: 404, and 200 inside the network. `deploy/Caddyfile` asks the Hub before every on-demand certificate, gives the relay the certificate's name as `Host` on the own-domain catch-all, and strips the port from Land hosts on the wildcard. "Your Land" in the Shell sets and removes the domain. Verified: `pnpm test` (447), `cargo test` (12), the Shell's browser tests in Chromium (35; Firefox not run locally), `caddy validate`, and Caddy 2.11.7 with its internal CA in front of the real relay (a domain the Hub allows gets a certificate and reaches the relay with `Host` set to it, one it refuses fails the handshake, plain HTTP gets a 308 to HTTPS). Real DNS answers `ENODATA` for a missing record, which counts as naming no Land.

- 2026-10-29: Step 2B item 9: containers, the public deployment example, the world end to end and the documents. The `Dockerfile` has a `wasm` stage (`rust:1.99.1-slim-trixie` with `wasm-bindgen-cli` 0.2.129, downloaded by checksum for the build machine's architecture) that builds `packages/core/pkg`, a `build` stage for the Land UI and the Shell, a `shell` target (`caddy:2.11.7-alpine` serving `dist/` with the headers of `src/headers.ts`, written out by `packages/shell/scripts/caddy-headers.ts`) and the runtime stage as the default target (hub-api, the relay and the Map server; its default command is a self-hosted Map server with its key in `/data`). `compose.yaml`'s `world` profile runs hub-api, the relay (on both loopbacks), the Shell on `SHELL_PORT` (8788) and `map-1`/`map-2`, each naming a development Character as `LAND_OWNER` and keeping its Map server key in its own volume; the development keys and the Characters' 24 words are labelled public. `deploy/` holds the public example: `Caddyfile` (the Shell, the Hub and `RELAY_HOST` by the HTTP challenge, `*.<LAND_BASE_DOMAIN>` by one DNS-01 wildcard; on `RELAY_HOST` only `/host/*` and `/health` are public), `compose.public.yaml` (Caddy built with `caddy-dns/cloudflare` v0.2.4 at a fixed address named in `HUB_TRUSTED_PROXIES`) and `.env.example`; `.dockerignore` keeps `deploy/` out of images. CI's `image` job builds both targets. `pnpm e2e:world` (`packages/shell/e2e-world/`, Chromium) runs Verification 4 against a live world: both Characters register their Map servers from the Shell, get adjacent cells, one walks from Land 1 through the east Gate into Land 2 and back through the west Gate, and `docker compose stop map-1` shows Land 1 offline in the Shell's Directory until it starts again. Fixed on the way: the Shell showed the Directory one answer late, because the Hub's `stale-while-revalidate=30`, meant for shared caches, let the browser answer each poll from its cache; the Shell's Hub client now sends every request with `cache: "no-cache"` (unit test; the world e2e failed on the offline status before the fix and passed twice in a row after it, on an already registered world). The Hub's header stays as the plan specifies. Documents: `README.md` (the own chain, the Rust and WebAssembly requirements, Run the world with the development Characters), `CONTRIBUTING.md`, `CLAUDE.md` (Foundry and Slither out, the WebAssembly build in), `docs/self-hosting.md` rewritten for `LAND_OWNER`, the Map server key, registering from the Shell and the cell sweep, the new `docs/runbooks/public-world.md` (names, DNS, the server, Caddy, the Hub's keys, the admin), the Shell and Map server READMEs; PLAN.md sections 3, 4 and 8 lose their until-2B notes, and the Reference Land kit is ticked. Deviations: the e2e restores the two development Characters from their 24 words instead of creating new ones, because `compose.yaml` names their addresses as `LAND_OWNER`; the Shell has no admin page, so the admin routes have no client yet (runbook, known limits). Verified: `pnpm format:check`, `lint`, `typecheck`, `test`; `cargo fmt --check`, `clippy -D warnings`, `cargo test`; the Shell's Playwright tests in Chromium (34); `pnpm e2e:world` twice; both images built and the world started from them; the public Caddy image built, `caddy validate` accepted `deploy/Caddyfile`, and a local run answered 404 on `/stats`, `/online` and `/` of `RELAY_HOST` while forwarding `/health` and `/host/1`. Not verified: Firefox locally (it does not start on macOS 27: `Could not find profile folder`; CI runs it), and the public deployment on real domains (Verification 6, with the project owner). The relay checkbox stays open until item 10 (own domains).
- 2026-10-29: Each package's `test` script gives Vitest its own module cache (`--fsModuleCachePath node_modules/.vitest-cache`). Vitest 5 keeps one cache for the whole workspace and empties it when the lockfile changes, so the packages that Turbo tests in parallel removed the same directory at once and one failed with `ENOTEMPTY`, on the first `pnpm test` after a lockfile change. Before: a stale lockfile hash failed 1 run in 3; after: 0 in 5, each package resetting its own cache.
- 2026-10-29: Step 2B item 8: the EVM design is deleted. Gone: `packages/miner`, `contracts/` (with its workspace, eslint, `.gitignore` and `.dockerignore` entries and the CI `contracts` job: Foundry, the ABI diff and Slither), `docs/runbooks/base-sepolia.md`, the compose services `anvil`, `deploy` and `seed` with `ANVIL_PORT`, and from `packages/shared` the ABIs, deployments, `chain.ts`, `format.ts`, the code generator and its outputs (`Rules.sol` cross-checks, `mining.json`, `spiral.json`), and the mining, sponsorship and Character stat rules. `viem` and Colyseus's `msgpackr-extract` are out of the workspace; `hash-wasm` stays for the Shell. `maps/empty-land.json` is now kept by hand; the Map server still checks it against `LAND_SIZE_TILES` when it loads. The world profile in `compose.yaml` still validates but stays broken until item 9. Verified: `pnpm test` (437, shared 116), `cargo test` (12), `docker compose config` with and without the world profile, and `docker build` (the CI `image` job).
- 2026-10-29: Step 2B item 7: `packages/shell`, a static Vite + TypeScript site with two pages. `setup.html` creates a Character from 32 random bytes shown as 24 words (three of them confirmed) or restores one from its words, and stores the bytes in IndexedDB under AES-GCM with an Argon2id key (`hash-wasm`, 64 MiB, t=3, p=1) and the address as additional data; the password needs 8 characters typed twice, and replacing a stored Character needs a tick. `index.html` unlocks, signs in to the Hub after every unlock (the session token lives in memory only), locks after 15 minutes without input or on Lock (the key freed, the bytes zeroed, the token dropped), shows the Directory, registers a Map server under "Your Land", and holds the Land in `<iframe sandbox="allow-scripts allow-same-origin allow-pointer-lock" allow="" referrerpolicy="no-referrer">` with a new handoff and `MessageChannel` on every load. It answers `travel`, `signMessage` and `pay` (`unsupported`) as `shell-land-ui.md` says; its signing prompt is a modal `<dialog>` with the frame inert, the Land's text with escapes, and an Approve that counts only a trusted pointer click after one second. Departures from the brief: a travel gets its ticket before the frame is replaced, so a refusal leaves the Character where it is, and that handoff serves the first load while under 30 s old; a `signMessage` without a usable id is dropped, since there is nothing to answer. `packages/shared/src/hub.ts` keeps only Gate numbers, `LandInfo`, `LandDirectory` and `shortAddress`; the Colyseus-era `protocol.ts` is deleted. A review found and fixed: a Land could reopen the password prompt without limit (a cancelled unlock now counts as a refusal, added to `shell-land-ui.md`); a second Land's request could change the text under an armed Approve, and a reload left the old prompt open (now one prompt for the whole Shell, closed as a refusal when its frame load ends); a travel whose ticket came back after the Player left still loaded the neighbour; a double submit in Setup could seal bytes the first submit had wiped (the button is disabled while storing, and `sealEntropy` copies its input); a restore left the decoded bytes in memory on its error paths; every Hub 409 read as `offline`, and a 404 named the Land. New CI job `browser`: Playwright in Chromium and Firefox against a stub Hub that checks every statement, with a hostile Land on `*.localhost`. Verified: `pnpm test` (483: shell 65, shared 131), `cargo test` (12), `forge test` (41); Playwright in Chromium 34 tests, three times in a row, and each new test fails with its fix taken out. Firefox was not run locally: Playwright's Firefox build stops with "Could not find profile folder" on macOS 27, inside and outside the sandbox, so its first run is in CI. The Reference Land kit checkbox waits for item 9, which runs the real client inside the Shell.
- 2026-10-29: Step 2B item 6: `relay`, `map-server` and `client` rewritten together for ML-DSA Lands and the protobuf game protocol (`map-server-hub-relay.md`, `arrival.md`, `land.proto`). The relay routes by host name: `<landId>.<LAND_BASE_DOMAIN>` reaches that Land and any other host gets the relay's own routes (`/host/<landId>`, `/online`, `/stats`, `/health`). A Map server proves its link with a `relay-host` statement signed by its Map server key, which must be the key the Hub has for that Land (rechecked every 30 s; close codes 4401, 4403, 4408, 4409 and 1013 as specified). Player HTTP is streamed in frames (32 MiB per response, 64 KiB request bodies, 504 after 30 s, at most a 4 MiB backlog per browser); every Land response carries `frame-ancestors` for `SHELL_ORIGINS` (or `'none'`) and `nosniff`, and a Land's own CSP is forwarded beside it (`map-server-hub-relay.md` now says so); an offline Land gets a 503 page. viem is gone from the relay. The Map server keeps its Map server key in a 0600 file, posts its statement to the Hub, waits for the owner's Delegation (`GET /lands?mapServerKey=` every 10 s), then dials the relay and serves the Land UI (`packages/client/dist`, `no-cache` with ETags for HTML, `immutable` for hashed assets) and `/play`: a hello with the handoff within 10 s, `verifyHandoff`, at most 64 Characters, 256 connections, 32 KiB frames and 30 inputs per second, 20 Hz movement. The client is the reference Land UI: it speaks the Shell ↔ Land UI API (`shell.ts`; outside a frame it only says "Open this Land from the Shell"), sends the handoff as its hello, draws Characters with their name or short address and separate "AI" and owner badges, and asks the Shell to travel at a Gate. Colyseus, the Mining key, the miner hookup, the Passkey wallet and dev wallet code, `GOLD` and the old e2e scripts are gone from these three packages; `shortAddress` moved to `packages/shared`. Choices the plan left open: `welcome` lists the newcomer too; a Map server that does not know its Land yet refuses a hello with `unavailable`; going over 30 inputs per second closes the socket (`rate-limited`); `moved` carries the last applied input `seq` and is sent even with no positions when that `seq` is new. A review found and fixed: the relay agent kept doubling its backoff after a link that had worked; the relay could leave an HTTP exchange open after its last frame and let a Land queue more than the pending-request cap; a browser that left mid-download kept the Map server's file open; a slow `/play` reader could grow the Map server's buffer without bound (now closed above 1 MiB); a name could imitate the "AI" or owner mark, or show nothing; held keys were lost before `welcome`. Not covered by tests: the relay's browser backlog drain and the Map server's 1 MiB send cap (both commented). The root `e2e:world` script is removed until item 9 brings the new e2e. Verified: `pnpm test` (457: relay 59, map-server 55, client 62), `cargo test` (12), `forge test` (41); with the real Hub (a scratch PostgreSQL database, dropped after), relay and two Map servers, 22 checks passed (registration and cells, relay headers and caching, welcome/moved/joined/left, a reused handoff and a second session refused, Gate tickets and placement), and in Chromium through a stand-in Shell a Player walked from Land 1 to Land 2 and back, and saw Land 2 offline in the Directory and in its frame after its Map server stopped; the badges were checked in a screenshot. The relay checkbox waits for own domains (item 10), the Reference Land kit checkbox for the Shell (item 7).
- 2026-10-29: Step 2B item 5: `hub-api` rewritten for ML-DSA identities (`identity.md`, `map-server-hub-relay.md`). Sign-in takes a `hub-sign-in` statement whose `Issued` is within 60 s of the Hub's clock, each nonce once; `PUT /me/name` keeps the Character's name. A Map server posts its statement (`POST /map-servers`), then the owner's Delegation registers the Land (`POST /lands`): one Land per Character, a newer Delegation replaces the Map server key, at most 3 new Lands per network address (IPv4, or IPv6 /64) per UTC day; both statements must be within 5 minutes of the Hub's clock. `GET /lands/:landId`, `GET /lands?owner=` or `?mapServerKey=` and `GET /directory` answer `LandInfo` with the Land's URL `<scheme>://<landId>.<LAND_BASE_DOMAIN>`. `POST /tickets` returns the signed `travel-ticket` statement itself (60 s; the arrival Gate comes from the two Lands' spiral cells) and answers 409 for a Land with no cell yet. The sweep (`src/sweep.ts`, every 15 s) records which Lands the relay has online, gives a waiting online Land the lowest free spiral index (the edge if it lost its cell), takes the cell of a Land offline for 30 days, and forgets old quota rows and, after 7 days, Map server statements that serve no Land. Migrations 003 to 005 drop `sponsorship` and `delegation`, add `map_server`, `land`, `character` and `land_quota`, and empty `report`, whose Land ids no longer exist. `src/network.ts`: `X-Forwarded-For` is read only behind `HUB_TRUSTED_PROXIES` (IPs or CIDRs), taking the rightmost entry no trusted proxy added. `@linked-realms/shared/identity` exports `isHost` and `isName`. SIWE, EIP-712, `POST /aa`, viem and the chain settings are gone. A review found two small faults, now fixed with tests: a used sign-in nonce could be forgotten up to 1 s before its statement failed the time check, and sending the registered Delegation again got a 409 instead of its `landId`. The sweep reads the relay's `GET /online`, which the relay serves in item 6. Verified: `pnpm test` (428, of which 55 in `hub-api`), `cargo test` (12), `forge test` (41); `src/main.ts` against the PostgreSQL container (a scratch database, dropped after) with a stand-in relay: migrations ran, a Map server statement and a Delegation registered Land 1, sign-in and a name worked, the sweep gave Land 1 cell (0, 0), and a Travel ticket was signed.
- 2026-10-29: Step 2B item 4: `packages/shared` gains `src/identity.ts` (subpath `@linked-realms/shared/identity`, so a Land UI that only needs the protocol does not load WebAssembly): it builds and strictly parses the seven statements of `identity.md`, signs and verifies them through `@linked-realms/core`, and `verifyHandoff` runs the nine checks of `arrival.md` in order and returns the first failing code. `test-vectors/statements.json` holds 14 valid and 43 refused statements, one per grammar rule, for other languages. `arrival.md` is simpler than the plan: a ticket carries its `publicKey`, and a Land checks that it hashes to `HUB_TICKET_SIGNER`, so a Map server no longer fetches `GET /keys` at start (`/keys` only publishes the key); the plan was updated to match. `identity.md` now states that `Message` has one canonical encoding (a reader re-encodes and compares) and that time values stop at 2^53 − 1, which a review found the parser enforced but the spec did not say. `hub.ts` gains `LandInfo` and `LandDirectory` beside the old names, which go in item 7. The Land protocol is `proto/linked_realms/land/v1/land.proto`, generated with `buf` and `protoc-gen-es` into `src/gen` (subpath `@linked-realms/shared/land-protocol`); CI gains a `buf` job that regenerates it and fails on any difference. Verified: `pnpm test` (437, of which 168 in `packages/shared`), `cargo test` (12), `forge test` (41), `buf generate` reproduces `src/gen`.
- 2026-10-29: Step 2B item 3: `packages/indexer` (Ponder) deleted with its mentions in `.dockerignore`, the `Dockerfile`, `README.md` and `packages/shared`; nothing imported it. Its dashboard returns with the chain in 2C. Verified: `pnpm test` (365), `cargo test`, `forge test` (41).
- 2026-10-29: Step 2B item 2 on branch `phase-2/2b-world` (plan: `docs/plans/phase-2b-world-without-chain.md`). Cargo workspace with Rust 1.99.1 pinned in `rust-toolchain.toml`. `crates/core` (`linked-realms-core`) implements `docs/protocols/identity.md`: 24 words over 32 bytes of entropy, Character keys through the BIP-39 seed and HKDF-SHA512, ML-DSA-44 hedged signing with a context (`fips204`), and `tlr` Bech32m addresses that parse only in their canonical form. A review found that non-zero padding bits let two strings parse to one address; the parser now re-encodes and compares, and `identity.json` carries one invalid address per rejection rule for other languages. Mnemonics, seeds and `xi` are wiped after use. `packages/core` is its WebAssembly build (`wasm-bindgen --target web`, 190 KB, 55 KB with Brotli), loaded synchronously in Node and with `ready` in browsers; Turbo builds it before any `typecheck` or `test`. CI gains a `rust` job and installs Rust and `wasm-bindgen-cli` (checksum-pinned) in the `typescript` job. Verified: `cargo test` (12: NIST ACVP ML-DSA-44 keyGen and sigVer, a cross-check with the `ml-dsa` crate, BIP-39 vectors, `identity.json`), `pnpm test` (379, including 25 in `packages/core` that recheck `identity.json` against Node's own PBKDF2, HKDF, ML-DSA-44 and keccak-256), `forge test` (41).
- 2026-10-29: Design review with the project owner on branch `design/own-chain` (docs only, no code changed). linked-realms moves to its own Proof-of-Work chain, written from scratch in Rust in `crates/`, with RandomX v2, ML-DSA-44 keys, 60-second Blocks, an LWMA Retarget after every Block, 5 `GOLD` per Block halved every 2,100,000 Blocks and then 0.3125 `GOLD` per Block forever, and Checkpoints every 10 Blocks (ADR 0006). The chain holds only money: Lands and names move to the Hub (free; anti-spam rules in section 5.1), items, Quests and stats belong to each Land, and NPCs are recorded nowhere (ADR 0007). Players' keys move to the Shell; each Land's UI runs in an isolated frame with its own rules; a few protocols are mandatory and the rest, including WebSocket + Protocol Buffers in place of Colyseus, are reference; NPCs are driven by the owner's own AI model and declare it at arrival (ADR 0008). The project owner approved the new principles P1–P10 (section 2). ADRs 0001–0005 are marked superseded where they relied on contracts; section 10 replaces D2, D3, D5, D8, D9 and D10, drops viem from D4 and adds D11–D15; Phase 2 gains steps 2B–2F in the order the owner chose (world first, then the chain, then the economy, then NPCs, then the audit before Phase 3). `CONTEXT.md` gains Land item, NPC, Shell, Quest, Node, Public node, Checkpoint, Checkpoint signer, Block and Map server key, and drops Passkey wallet, Backup passkey, Sponsored transaction, Round, Challenge and Mining key. The Base Sepolia deployment and the CDP spike are no longer needed.
- 2026-10-29: D5 built on branch `phase-2/d5-embedded-wallet` (plan: `docs/plans/phase-2-d5-embedded-wallet.md`). The project owner chose option F, no recovery, and 1 Character plus 20 game transactions per day per identity; ADR 0005 accepted. `packages/shared` holds the sponsorship rule (`SPONSORED_CALLS`, 20 per Player and 10,000 for the world per UTC day). `hub-api` gains `POST /aa`, a JSON-RPC proxy to `HUB_BUNDLER_URL` (the CDP endpoint, server only) that forwards only a signed-in Player's own user operations with sponsored calls, refuses a second Character, and counts Sponsored transactions in PostgreSQL. The client offers a Passkey wallet on every chain except anvil: create, sign in (a new device recovers the passkey's public key from two signatures, so no server stores passkeys), sponsored `createCharacter()` through the Hub, and "Add backup passkey" while the wallet has one owner; every wallet now sends through `Wallet.send`, and a Sponsored transaction signs in to the Hub again when the session is missing or within a minute of expiry. `CONTEXT.md` gains Passkey wallet, Backup passkey and Sponsored transaction. Verified: `pnpm test` (354), `forge test` (41, contracts unchanged); on an anvil fork of Base Sepolia (real factory and EntryPoint, game contracts deployed to the fork, a stand-in bundler, Chromium's virtual authenticator) a Passkey wallet signed in to the Hub before deployment, created its Character in its first user operation (which deployed it), signed a Delegation the Hub accepted, added a Backup passkey (2 owners on chain, 2 Sponsored transactions counted), and with storage cleared each passkey alone found the same wallet and signed in; the dev wallet still creates a Character on anvil. Not done here: the spike against the real CDP Paymaster (needs the owner's CDP account and the Base Sepolia deployment, runbook section 7) and the bot check on `createCharacter()` (needs the owner's choice of service).
- 2026-10-29: Phase 2 work on branch `phase-2/open-testing` (plan: `docs/plans/phase-2-open-testing.md`). The image's default command is now a self-hosted Map server with its Mining key in the `/data` volume; `docs/self-hosting.md` covers building it from the repository, `land.env`, the one `docker run` command, registering the Mining key under "Your Land", mining, updates, moving machines and troubleshooting by log line; CI builds the image on every pull request (publishing it is the owner's step). The indexer serves `GET /dashboard` (server-rendered, no script): Lands online from the Hub's Directory, mines mining (reward wallets that won a Round in the last 24 hours), mean Round time over the last 100 won Rounds, estimated hash rate from `GoldMine.target()`, and Rounds won per Land over the last 1,000. `formatHashRate` moved to `packages/shared` so the client and the dashboard share it. D5: research brief and ADR 0005 (proposed: Coinbase Smart Wallet account with a passkey through viem, CDP Paymaster gated by `hub-api`); waiting for the project owner. `docs/runbooks/base-sepolia.md` and `pnpm --filter @linked-realms/contracts deploy:base-sepolia` (Foundry keystore account) for the owner to open the testnet world, ending with the Stage 1 three-machine checklist. Verified: `pnpm test` (341), `forge test` (41), Slither 0 findings; the deploy script on an anvil with chain id 84532 used the real mining rules and handed ownership to `OWNER`; the `world` profile now runs the Map servers on the image's defaults and `pnpm e2e:world` passed; the guide's `docker run --env-file` command hosted Land 5 in the local world, loaded its Mining key from the volume and showed it online; the dashboard ran against the local chain with 54 won Rounds and the world Hub (4 Lands online), and was checked in the browser in light and dark mode. Not done here (needs people or the owner): the Base Sepolia deployment, a public Hub and relay, publishing the image, the D5 choice, and the Done-when criterion of 10 outside Lands connected for a week.
- 2026-10-29: Phase 1C built on branch `phase-1c/connectivity` (plan: `docs/plans/phase-1c-connectivity.md`, decisions: ADR 0004; the project owner waived the per-step approval gate for this run). `packages/hub-api` (Hono, PostgreSQL via `pg`, PGlite in tests): SIWE sign-in, Delegations signed by the Land owner (EIP-712, checked against `Land.ownerOf`), the Directory with online status read from the relay, Travel tickets (EIP-712, 60 s, adjacency checked from on-chain coordinates), abuse reports and admin hiding. `packages/relay` (Node.js + `ws`): one outbound link per Map server proven with the Mining key, Player HTTP and WebSockets multiplexed over it, per-Land and per-session counters, bounded buffers, and a k6 load test (200 Players, about 2,900 messages/s in and 5,800/s out, p95 202 ms on one laptop). Map servers verify tickets offline and spawn Characters at the arrival Gate; Gates are 2 tiles in the middle of each edge, stored in the map. The client signs in, lists the Directory, enters Lands through the relay, travels through Gates and draws them. One `Dockerfile` and a `world` compose profile run anvil, `hub-api`, the relay and three Map servers in three containers. Verified: `pnpm test` (332), `forge test` (41), Slither 0 findings; `pnpm e2e:world` passed (a Player walks from Land 1 through the east Gate into Land 2 and arrives one tile inside its west Gate; stopping `map-1` shows Land 1 offline after 1.5 s and online again 1.8 s after restart); in the browser a Player signed in, entered Land 1 through the relay, walked to Land 2 and back, and saw "No Land to the north" at an edge with no neighbour. The browser check found that the first build offered "Register" only inside the Land, which the relay refuses until the Land is registered; registration moved to the Land owner's panel (paste the Mining key address the Map server prints), and a fresh Map server container for Land 5 was registered that way, came online, and its owner switched mining on and off through the relay.
- 2026-10-29: Phase 1B built on branch `phase-1b/mine` (plan: `docs/plans/phase-1b-mine.md`, decisions: ADR 0003). Contracts `GoldToken` (capped at 21 million, only `GoldMine` mints) and `GoldMine` (Rounds, Solution check, Land check, halving, Retarget). `packages/miner` (worker threads, `hash-wasm` keccak256, 1 thread by default, polls the Round each second, submits with the Mining key); the Map server's owner-only mining switch with status shown to everyone on the Land; the client's `GOLD` balance, Rounds won and mining controls; the indexer's `round_won` and `retarget` tables. Initial Target calibrated at 3.2 million hashes per second per thread on the reference machine. The simulation test (`GoldMine.simulation.t.sol`) shows Round time returning to 60 s after hash rate rises 4× and falls to half. Verified: `forge test` (41), Slither 0 findings, `pnpm test` (176). On anvil with 5-second Rounds and a Retarget every 10 Rounds, `e2e:mining` ran two Map servers for two Lands mining together: 50 of 50 Rounds were won, each reward went to the owner of the Land whose Map server submitted it, both `GOLD` balances equal their summed rewards, and mean Round time per Retarget window went 1.0 → 2.3 → 6.6 → 6.4 s against the intended 5 s. The run found and fixed a miner defect: right after a win, a pre-flight `eth_call` sees `RoundAlreadyWonInThisBlock` and the miner dropped good Solutions (on an automining anvil the Mine stalled). In the browser, the Land owner switched mining on, won Rounds and saw `GOLD` and the Rounds won; a visitor saw the mining status without the controls.
- 2026-10-29: Phase 1A built on branch `phase-1a/land-and-characters` (plan: `docs/plans/phase-1a-land-and-characters.md`, decisions: ADR 0002). Contracts `PlayerRegistry` and soulbound `Land` (owner's decision) with spiral coordinates; rules reach the contracts through generated `Rules.sol` and cross-check vectors (P9). `indexer` (Ponder 0.18), `map-server` (Colyseus 0.18, authoritative 20 Hz movement, signed join message checked against the chain) and `client` (Phaser 4, dev wallet on anvil, Land map validated per P6). Verified: `forge test` (19), Slither 0 findings, `pnpm test` (101); on anvil two browser Players each created a Character with 4 stats equal to 1, received Lands 11 and 12, entered Land 1, saw each other and walked; the Mine blocks movement.
- 2026-10-29: Phase 0 built on branch `phase-0/foundations`: monorepo (Node.js 26, pnpm 11.3, Turborepo, TypeScript 6.0, ESLint, Prettier, Vitest), `contracts/` (Foundry 1.8.6, OpenZeppelin 5.6.1), `compose.yaml` (PostgreSQL 18.6, anvil), `packages/shared` rules, CI, ADR 0001. Verified locally: `pnpm test`, `forge test`, Slither and `docker compose up -d` are green. CI (`typescript`, `contracts`) is green on GitHub; secret scanning, push protection and `main` branch protection (PR required, both checks required, no force-push) are on. Phase 0 is done once the project owner merges PR #1.
- 2026-10-29: Section 10 confirmed (D1–D4, D6–D10; D5 before Phase 2); connection scaling rules added as section 3.5. PLAN.md and CLAUDE.md translated to English; `CONTEXT.md` glossary added.
