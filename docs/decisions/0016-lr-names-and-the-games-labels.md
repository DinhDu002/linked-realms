# 0016 — LR's names, and the game's labels out of LR's code

Status: accepted, 2026-11-02 — by the project owner, who chose the recommended answer to each of four questions on the game terms that `CONTEXT-MAP.md` found in LR's paths. It changes ADR 0009 decision 2 (where the labels live, not their values), the Checkpoint context of ADR 0012 decision 7, and the transaction context of the step 2C plan, and it resets the test network under ADR 0012 decision 6.

## Context

LR moves to its own repository before the genesis (ADR 0015 decision 6), and Linked Realms is only its first application. A few Linked Realms terms were in LR's code: the salt and info that derive a Character's key, the `linked-realms/…` contexts of transaction and Checkpoint signatures, the Mine id `land`, and the crate names. A label inside a signature or a key derivation cannot change later without changing every key or signature made with it. Today only test networks on the project owner's machines and in tests use them, so changing them now costs little. After the genesis, which is never reset, it would cost a network upgrade.

## Decisions

1. **LR derives a key from 24 words under a salt and an info that the application chooses.**
   - `crates/core` has `derive_seed(entropy, salt, info)`, and the WebAssembly `Key.fromEntropy(entropy, salt, info)`, in place of `character_seed(entropy, index)`.
   - Linked Realms keeps its labels, `linked-realms/ml-dsa-44/v1` and `character/{index}`, in `packages/shared` (`characterKey`), which also checks the index.
   - Every key and address stays the same.
   - Rejected: new neutral labels, which would change every Character's address; keeping the labels in LR.
2. **The signing contexts are LR's: `lr/tx/v1` and `lr/checkpoint/v1`.**
   - They replace `linked-realms/tx/v1` and `linked-realms/checkpoint/v1`, before the genesis.
   - Old transactions and Checkpoints stop verifying, so the test network is reset the way ADR 0012 decision 6 sets out: network id 3 instead of 1, and the genesis timestamp 2026-11-02 00:00 UTC (1,793,577,600). A Node then refuses a data folder from before the reset, and its P2P magic, which comes from the genesis id, no longer matches an old Node's. The dev network keeps id 2 and its genesis; its data on any machine is only for development.
   - Rejected: keeping them, which would freeze the game's name into every LR signature forever.
3. **The Node's one Mine is `default`, not `land`.** The Map server sends the new id; the two ship together in the Land image.
4. **The crates are `lr-core`, `lr-node` and `lr-randomx`.** LR's repository is to be `DinhDu002/lr`, which the project owner creates at item 28. Two names wait for item 28:
   - the Cargo `repository` field, until that repository exists;
   - the name LR publishes its WebAssembly package under. GitHub Packages takes a package only under its owner's scope (`@dinhdu002/…` for this account), so the `@lr/core` first proposed does not fit it. Until then the package stays `@linked-realms/core` inside this repository.
   - The Land image keeps its name, `linked-realms-node`: it is Linked Realms' artifact, and published commands use it.

## Consequences

- The test network starts again from a new genesis. Gold won on it before stays on network 1, which no Node of this version joins.
  - Before an image from this change runs, the Node data made before it is deleted. That is the volumes of `deploy/compose.chain.yaml`, and each Land's `lr-node` folder beside its Map server key. The Land's own data stays. A Node that still finds old data refuses to start rather than run the old chain.
  - The Checkpoint signer keeps its key and runs again from an image built after this change.
  - The Shell's `NETWORK_IDS` names the test network 3.
- In `chain.json`, the test network's values change: its id, genesis Block, genesis id and every transaction signed for it. On the dev network only the signatures and the bytes that hold them change; the ids of its transactions and Blocks and its state roots stay. `identity.json` gains each Character key's salt and info.
- The identity vectors that use Linked Realms' labels, and its statement contexts, still live in `crates/core/test-vectors/identity.json`. They go to Linked Realms at the split, and LR then makes its own key vectors.
