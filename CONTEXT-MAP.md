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

The project owner settled the game terms that were in LR's paths (ADR 0016):

- key derivation takes the salt and info as parameters, and Linked Realms keeps its own, `linked-realms/ml-dsa-44/v1` and `character/{index}`, in `packages/shared` (`characterKey`);
- the signing contexts are LR's, `lr/tx/v1` and `lr/checkpoint/v1`;
- the Node's Mine id is `default`;
- the crates are `lr-core`, `lr-node` and `lr-randomx`.

Left for the split: the identity vectors that use Linked Realms' labels and statement contexts move from `crates/core/test-vectors/identity.json` to Linked Realms, and the Cargo `repository` field and the name of the published WebAssembly package are set once LR's repository exists.
