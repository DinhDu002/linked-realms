# 0015 — LR, its own product, and its main network

Status: accepted, 2026-10-30 — by the project owner, in a design review that began with the question whether the chain and the game should be two repositories. It replaces P7 (approved by the project owner), supersedes parts of ADR 0006 (points 9, 11 and 12, the audit in point 4, and the Consequences), drops the legal review that ADR 0008 decision 7 placed in Phase 3, and changes ADR 0011 (decisions 3 and 8) and the step 2C plan's answers 13, 19 and 22.

## Context

ADR 0006 built the chain for the game: a test network only, reset with notice, with Gold worth nothing until Phase 3 and a written decision (P7). The project owner sees the chain as a mechanism that other applications could use, not only the game, and asked whether it should live in its own repository. The review settled what the chain is, when its main network starts, how long Checkpoints last, when the repository splits, and how fast the state may grow. Step 2C items 1 to 4 were built; no network had run, so no encoding was frozen yet.

## Decisions

1. **The chain is its own product, named LR.**
   - Linked Realms is its first application; others may use it.
   - The coin keeps its name, Gold (`GOLD`). Addresses start with `lr` on the main network and `tlr` on the test network (ADR 0009).
   - Rejected: a neutral name such as Cairn. The project owner kept the shared name, at the risk of confusion with an unrelated game token whose ticker is also LR. Realm was rejected too: tokens already use it.
2. **Money only, plus a few fixed money rules.**
   - LR holds money and nothing else (P8): no virtual machine, no items, no tokens.
   - A new money rule, such as escrow, comes only through a network upgrade, one at a time, each with its own ADR.
   - So that such a rule can keep its own state, every state-tree key starts with a kind byte, and an Account is kind 0 (ADR 0011 decision 7, changed before item 5).
   - Rejected: tokens, NFTs, contracts or stored data on the chain, which contradict P8 and the Bitcoin-like design of ADR 0006.
3. **LR has a standalone mine command; "No Land, no Mine" is a Linked Realms rule.**
   - LR's Node gets a command that mines for one address. It runs only when its owner starts it, with a thread cap (P5).
   - Linked Realms keeps "No Land, no Mine": its reference Land kit and Shell offer a Mine only as part of a Land, mining for the Land owner (step 2C plan, Answer 19; ADR 0014 records it).
   - The chain cannot enforce the Land rule anyway: Proof of Work checks only the Solution, the reward address can be any address, and the code is open, so anyone can change `lr-node` to mine without a Land. A chain meant for more than one application should not tie its Mines to one application's Lands.
   - Rejected: keeping Answer 19 as it was, with no standalone mine command in LR.
4. **The main network starts after step 2C and is never reset (P7).**
   - Step 2C's acceptance test, three Players on three machines, still runs on the test network first. The test network serves only that test, may be reset, and stops once the main network starts.
   - Network upgrades are tested locally, on the dev network and in tests with several Nodes; no public test network runs beside the main network.
   - Only the project owner launches the main network, quietly, as Bitcoin was launched in 2009, with no premine.
   - The main network's id, its genesis, the `lr` prefix and the end of Checkpoints (decision 5) join `ChainParams` at the end of step 2C. After the genesis its rules change only through network upgrades (P10).
   - Rejected: a test network only until a later phase and a written decision (the old P7 and Phase 3). Rejected: announcing the launch in advance, with the installer and the genesis rules published two weeks before and a genesis that holds a public value nobody can know early; the project owner chose a quiet launch.
5. **The project owner holds the Checkpoint signer's key, and Checkpoints end.**
   - The project owner personally holds the key, on a machine separate from the carthings server (step 2C plan, Answer 13).
   - Checkpoints end at height 1,051,200, about two years of 60-second Blocks. The height is written in the main network's genesis code: no Node accepts a Checkpoint above it.
   - A network upgrade may end Checkpoints earlier once all four of these hold: 12 months without a consensus bug, no reorganisation deeper than 6 Blocks, no Mine with more than 30% of the hash rate, and at least 20 independent Nodes.
   - Keeping Checkpoints past that height also needs a network upgrade.
   - Rejected: a company-held signer, a 2-of-3 signature, and ending Checkpoints on a promise to delete the key. Nobody can check that a key was deleted, and Nodes would still accept its Checkpoints. Rejected: leaving the end height to a later decision, which keeps the trusted role open-ended.
6. **The repository splits at the end of step 2C, before the genesis.**
   - LR moves to its own repository with `git filter-repo`, so its history comes with it.
   - Until then LR has its own glossary, `crates/CONTEXT.md`, and new Linked Realms terms stay out of the paths that go with LR (`CONTEXT-MAP.md`). The game terms already there are listed in `CONTEXT-MAP.md`.
   - Rejected: splitting now, which turns every step 2C item that touches both the chain and a Land (17, 19 and 21 to 24) into pull requests in two repositories, and needs the WebAssembly package published to npm first. Rejected: waiting for a second application.
7. **State growth: at most 50 new Accounts per Block (R2), path-compressed storage (R1), and a relay dust policy (A').** This replaces Answer 22's bound, which was the Block size alone.
   - **R2, a chain rule:** a Block creates at most 50 new Accounts, counted as the number of Accounts after the Block minus the number before it, the reward address included. Item 5 adds it to `validate_block` and writes it into ADR 0011 decision 8, Answer 22 and `docs/protocols/blocks.md`.
   - **R1, storage only:** `crates/core` stores the state tree with one entry per branching node, so a key that shares a long prefix with another adds no extra entries. The hashes do not change (ADR 0011 decision 7). It comes before item 11.
   - **A', relay policy only:** a Node does not relay a transfer that creates an Account with a dust amount. Item 12, the mempool, sets the amount.
   - The Node and the dashboard count the new Accounts of each Block and of each Mine, by reward address.
   - The bound: 50 × 1,440 = 72,000 new Accounts a day, about 23 MB a day (about 8.3 GB a year) with R1, at about 315 bytes per Account before `redb`'s overhead. This is an estimate; item 11 measures it. Item 11 measured about 450 bytes per new Account on `redb` 4.4.0 with R1 (468 as written in transactions of 50 new Accounts, 444 after compaction), so the bound is about 32 MB a day, about 12 GB a year. Without these rules the bound was about 160 MB a day for random keys and about 1 GB a day for ground keys (ADR 0011 decision 8).
   - Why a chain rule: relay policy does not bind the Mine that builds a Block. In 2023 a Bitcoin pool mined a Block filled by one transaction that default relay refuses (height 774,628), and Zcash's ZIP-317 states that its fee formula is not consensus. Chains without a bound have paid for it: about 19 million empty accounts on Ethereum in 2016, until EIP-161 stopped their creation, and a dust attack on Kaspa, stopped by a mempool patch and later bounded in consensus by KIP-9's storage mass.
   - Rejected: 20 new Accounts per Block (about 9 MB a day, but 10,000 newcomers arriving at once would wait about 8.3 hours instead of 3.3). Rejected: a permanent reserve in each Account, as on XRPL and Stellar, which needs a minimum amount that Answer 22 declined. Rejected: weighting new Accounts inside the Block size, which reaches the same bound with more rules. Deferred: deleting Accounts.
8. **No gates before the genesis.**
   - No legal opinion and no audit are needed before the main network starts.
   - The independent audit (step 2F) stays and runs after the genesis. The legal review leaves PLAN.md.
9. **Each NPC has its own Account.** Its owner funds it with just what it needs, so a leaked NPC key loses only that. LR gains no rule for spending on another address's behalf. Rejected for now: a spending allowance in the chain rules, which needs a new transaction kind and its own state.

## Consequences

- The project owner accepts the legal risk of a main network with no legal opinion: Gold may gain value from the first Block.
- A quiet launch is not a premine: every Block, the first ones included, is mined under the same rules, and the genesis gives Gold to no one. The first Blocks will mostly go to whoever mines first, most likely the project owner, which can look like a premine to an outsider.
- With no public test network, every upgrade runs in public for the first time on the main network. Local tests on the dev network and with several Nodes are the only checks before it.
- Until Checkpoints end, one key can override most work. If it leaks, history up to the last honest Checkpoint can be rewritten, and only a network upgrade replaces the key (ADR 0006). The end height limits this trust in the code from the genesis.
- What vectors freeze becomes permanent at the genesis, not only until a reset: after it, only network upgrades change it.
- PLAN.md: P7 is replaced, step 2C gains the repository split and the main network launch, step 2F runs after the genesis, and Phase 3 is removed.
