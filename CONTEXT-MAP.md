# Context Map

## Contexts

- [Linked Realms](./CONTEXT.md): the game. Lands, Characters, NPCs, the Hub, the relay and the Shell.
- [LR](./crates/CONTEXT.md): the chain. Gold, Accounts, Blocks, Nodes, Mines and Checkpoints.

## Relationships

- **Linked Realms → LR**: Linked Realms is LR's first application (ADR 0015). A Character's address is an LR address; the Shell signs LR transactions with the WebAssembly build of `crates/core`; each Land runs a Node and its Mine; a Land item or a Quest reward is paid in Gold. LR knows only addresses: it knows nothing of Lands, Characters, Players or the Hub.
- **Mines**: LR lets any Node run a Mine for any address. "No Land, no Mine" is a Linked Realms rule: the game offers a Mine only as part of a Land.

## What goes with LR at the split

At the end of step 2C, before the genesis, LR moves to its own repository with `git filter-repo` (ADR 0015). Until then these paths belong to LR, and new Linked Realms terms stay out of them:

- `crates/` (with LR's glossary, `crates/CONTEXT.md`), `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml`;
- `packages/core`, the WebAssembly build of `crates/core`;
- `docs/protocols/transactions.md` and `docs/protocols/blocks.md`, and the address encoding in `docs/protocols/identity.md`;
- the chain's ADRs: 0006, 0011, 0012, 0013 and 0015;
- the Rust jobs of `.github/workflows/ci.yml`.

Some game terms are already in these paths, such as the `character/{index}` label in key derivation and the `linked-realms/…` signing contexts. Changing a label changes every key or signature made with it, so the project owner decides them before the split.
