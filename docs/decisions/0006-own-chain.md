# 0006 — Own Proof-of-Work chain

Status: accepted, 2026-10-29 — by the project owner

Supersedes ADR 0003 and decisions D3, D8, D9 and D10 in ADR 0001. Parts of ADR 0002, 0004 and 0005 that rely on contracts are superseded too (see ADR 0007 and 0008).

## Context

Phases 0 to 2 put Gold, Characters and Lands in Solidity contracts on Base Sepolia. A Map server mined a keccak256 puzzle and sent each Solution to `GoldMine`, paying gas with a Mining key; new Players needed a CDP paymaster (ADR 0005) so they would not need gas. The project owner wants the mechanism to work like Bitcoin itself: every Land runs a Node of the game's own chain, Gold is mined into Blocks, and the Mine on each Land can be switched on and off. The decisions came out of a design review with the owner on 2026-10-29.

## Decisions

1. **An own chain, written from scratch in Rust.** The EVM path is dropped now, not kept beside it. Reasons: no paymaster or gas token, the Node is the same program on every Land, and the rules live in one place. Rejected: forking btcd or Bitcoin Core (UTXO-only, so account state would be a new layer anyway), a TypeScript chain (heavier per Node, and the owner asked for small and fast), Substrate (large framework for a small world).
2. **Crates.** One Cargo workspace in `crates/`, in this repo:
   - `crates/core`: transaction encoding, hashing, signing, addresses and every chain rule. It compiles natively and to WASM through `wasm-bindgen` (no `wasm-pack`), so the Shell signs with the same code the Node checks with (P9).
   - `crates/node`: the Node (Blocks, mempool, storage, P2P, JSON-RPC) and the Mine.
   - Libraries: `sha3` (keccak256), `fips204` for ML-DSA, cross-checked against RustCrypto `ml-dsa` and NIST vectors, `redb` for storage, `jsonrpsee` for JSON-RPC. P2P is a hand-written Bitcoin-like TCP protocol behind an interface, so `libp2p` can replace it later.
3. **Account model.** Each address has a balance, a nonce and its public key. The chain holds only money (P8): Lands, names, items and stats are not on it (ADR 0007).
4. **Signatures: ML-DSA-44 (FIPS 204)** for resistance to quantum computers.
   - Addresses and transactions carry a scheme id, so another scheme can be added by a network upgrade (P10).
   - A key-rotation transaction exists from day one.
   - The public key (1,312 bytes) travels only in an address's first transaction and is then kept on chain. A signature is 2,420 bytes.
   - Keys come from a 24-word seed phrase generated in the Shell.
   - Neither ML-DSA crate is independently audited. The library is pinned, tested against NIST vectors and audited before Phase 3.
5. **Proof of Work: RandomX v2**, from the first Block.
   - The pinned upstream is `tevador/RandomX` v2.0.1 with `RANDOMX_FLAG_V2`, behind a small FFI binding of our own: `randomx-rs` supports only v1.2.2.
   - v2 does about 53% more work per hash than v1 and reduces hardware advantages that v1 gave to specialised machines. Monero's mainnet still runs v1, so the hash rate it attracts does not carry over to this chain one for one.
   - A Node verifies in light mode, which needs a 256 MiB cache. Checking one Block takes tens of milliseconds on a desktop CPU and a few hundred on a Raspberry Pi (RandomX README figures for v1; v2 does more work), which is small next to a 60-second Block. Step 2C measures it. A Mine uses fast mode (about 2,080 MiB) when the machine has the memory, and light mode otherwise, which is 3.4 to 6.6 times slower.
   - Official test vectors run on x86 and ARM, because v2.0.1 and v1.2.2 fixed an invalid-hash bug on ARM and RISC-V.
   - keccak256 stays for transaction ids, Merkle roots and addresses.
   - Rejected: keccak256 or SHA-256d for PoW, because GPUs and ASICs beat a CPU by orders of magnitude.
6. **Blocks.** One Block every 60 seconds on average. The Retarget runs after every Block with LWMA; a retarget every 2,016 Blocks fails on a small, bursty world. A Block holds at most 1 MB, which is about 400 transactions of about 2.4 KB.
7. **Issuance (P4).**
   - 5 GOLD per Block, halved every 2,100,000 Blocks (about 4 years).
   - After four halvings (about 16 years, 19,687,500 GOLD issued), 0.3125 GOLD per Block forever: 164,250 GOLD a year, about 0.83% a year and falling.
   - 8 decimals; amounts fit in `u64` for over a million years.
   - No premine and no developer fund.
   - The tail reward keeps paying Mines to secure the chain once halvings make the Block reward small.
8. **Fees.** A per-size fee auction with a minimum relay fee. The fees and the Block reward go to whatever address the sealing Mine names. A transfer may carry a memo of up to 80 bytes, paid by size, so a purchase can say what was bought. Newcomers get Gold by mining or by being sent some.
9. **Checkpoints.** Every 10 Blocks the Checkpoint signer, a company service separate from the Hub with its own key, signs a Checkpoint. No Node accepts a history that changes anything before it. This is the answer to 51% attacks, which small PoW chains have suffered (Bitcoin Gold, Ethereum Classic, Horizen). Even RandomX on Monero came under pressure from rented hash power in 2025.
10. **Network roles.**
    - Nodes are pruned by default and start from a Checkpoint snapshot. Block headers carry a state root from day one, so a snapshot can be checked.
    - The company runs an archive, the seed nodes and the Public node as separate services.
    - Browsers read the chain through the Public node by default, and a Player may choose any other Node.
11. **The Mine.**
    - A Mine runs beside a Node on a Player's own server and mines for one address. A Player may run any number of Mines there; each starts switched off and has a CPU limit (P5).
    - A Mine can run before its Player has a Land, so a newcomer can earn Gold without help.
    - We ship no program that mines on other machines. The chain cannot tell where a Solution was computed, so this is a product choice, not a rule.
    - The Mining key is gone: a Mine needs no key, because its reward address is in the Block it mines.
12. **Rules and upgrades.** Only the project owner changes chain rules, through network upgrades. The network is a test network that the owner may reset with notice. Gold has no value until Phase 3 and a written decision (P7).

## Consequences

- `contracts/`, `packages/indexer` and `packages/miner` are deleted in step 2B (PLAN.md section 6). The chain rules in `packages/shared/src/rules` move to `crates/core`. The CDP key and the Base Sepolia deployment are no longer needed.
- Building a Node needs CMake and a C++ compiler, because RandomX is C++. A Node with the default settings needs about 256 MiB more memory than a Map server alone, and a Mine in fast mode needs about 2 GB.
- Consensus code, ML-DSA and the RandomX binding are new and unaudited. An independent audit comes before Phase 3 (step 2F in PLAN.md section 6).
- The Checkpoint signer is a trusted company role. If its key leaks, rewrites up to the last honest Checkpoint become possible, and the key can only be replaced by a network upgrade.
