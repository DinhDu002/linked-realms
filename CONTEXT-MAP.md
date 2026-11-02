# Context Map

## Contexts

- [Linked Realms](./CONTEXT.md): the game. Lands, Characters, NPCs, the Hub, the relay and the Shell.
- [LR](./crates/CONTEXT.md): the chain. Gold, Accounts, Blocks, Nodes, Mines and Checkpoints.

## Relationships

- **Linked Realms → LR**: Linked Realms is LR's first application (ADR 0015). A Character's address is an LR address; the Shell signs LR transactions with the WebAssembly build of `crates/core`; each Land runs a Node and its Mine; a Land item or a Quest reward is paid in Gold. LR knows only addresses: it knows nothing of Lands, Characters, Players or the Hub.
- **Mines**: LR lets any Node run a Mine for any address. "No Land, no Mine" is a Linked Realms rule: the game offers a Mine only as part of a Land.

## What goes with LR at the split

At the end of step 2C, before the genesis, LR moves to its own repository with `git filter-repo` (ADR 0015). Until then these paths belong to LR, and new Linked Realms terms stay out of them.

Whole paths that move:

- `crates/` (with LR's glossary, `crates/CONTEXT.md`, the vendored RandomX, the test vectors and the public Checkpoint signer keys in `crates/core/keys/`), `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml`;
- `packages/core`, the WebAssembly build of `crates/core`, which LR then publishes as a package for Linked Realms to depend on;
- `docs/protocols/transactions.md`, `blocks.md`, `node-p2p.md` and `node-rpc.md`;
- the chain's ADRs 0011, 0012 and 0013;
- `deploy/compose.chain.yaml` and `deploy/compose.signer.yaml`.

Parts of files that move, the rest staying with Linked Realms:

- `docs/protocols/identity.md`: Keys, Addresses and Test vectors; Signed statements stay;
- `docs/protocols/map-server-node.md`: the control listener, Methods and Errors, which are the Node's side; the switch and `land.proto` stay;
- ADR 0009: decisions 1 to 3 (the signature scheme, keys from 24 words, addresses);
- `docs/runbooks/public-world.md`: section 7, the chain;
- `deploy/.env.example`: `RPC_DOMAIN`, `LR_P2P_PORT` and `LR_NETWORK`;
- `Dockerfile`: the stages `wasm-bindgen-*`, `wasm`, `chain` and `lr-node`;
- `.github/workflows/ci.yml`: the `rust` job; LR also needs its own workflow to publish the `lr-node` image;
- `.gitignore`, `.prettierignore` and `.dockerignore`: the lines for `target/` and `crates/`.

Copied to both: ADR 0006 (it decides the chain and the Mine in a Land together), ADR 0015, `LICENSE`, and a `CLAUDE.md` and `AGENTS.md` of LR's own.

What stays with Linked Realms and then depends on LR:

- ADR 0014, `PLAN.md` and the plans in `docs/plans/`;
- the chain's end-to-end tests in `packages/shell/e2e-chain`;
- the Land image, which keeps bundling `lr-node`, taken from an LR release instead of a `chain` stage;
- the Rust and `wasm-bindgen` steps of the `typescript` and `browser` CI jobs, which go once `packages/core` comes as a package;
- the tests that read LR's vectors by path: `packages/shell/src/config.test.ts` (`chain.json`) and `packages/shared/src/identity.test.ts` (`identity.json`).

Some game terms are already in LR's paths, and the project owner decides them before the split, because changing a label changes every key or signature made with it:

- `character/{index}` and the salt `linked-realms/ml-dsa-44/v1` in key derivation (`crates/core/src/lib.rs`): every key and address made from 24 words;
- the contexts `linked-realms/tx/v1` (`tx.rs`) and `linked-realms/checkpoint/v1` (`checkpoint.rs`): every transaction and Checkpoint signed so far;
- the statement contexts in `crates/core/test-vectors/identity.json`, which are game data and can move to the game's vectors;
- `MINE_ID = "land"` in `crates/node/src/control.rs`, which the Map server sends too;
- the names `linked-realms-core`, `linked-realms-node`, `linked-realms-randomx` and `character_seed`, and the Cargo `repository` field.
