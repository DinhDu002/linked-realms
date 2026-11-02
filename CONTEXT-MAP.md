# Context Map

## Contexts

- [Linked Realms](./CONTEXT.md): the game. Lands, Characters, NPCs, the Hub, the relay and the Shell.
- [LR](https://github.com/DinhDu002/lr/blob/main/CONTEXT.md): the chain. Gold, Accounts, Blocks, Nodes, Mines and Checkpoints.

## Relationships

- **Linked Realms → LR**: Linked Realms is LR's first application (ADR 0015). A Character's address is an LR address; the Shell signs LR transactions with `@dinhdu002/lr-core`, the WebAssembly build of LR's `crates/core`; each Land runs a Node and its Mine; a Land item or a Quest reward is paid in Gold. LR knows only addresses: it knows nothing of Lands, Characters, Players or the Hub.
- **Mines**: LR lets any Node run a Mine for any address. "No Land, no Mine" is a Linked Realms rule: the game offers a Mine only as part of a Land.

## LR is a separate repository

LR, the chain, lives in <https://github.com/DinhDu002/lr> (ADR 0017); its glossary is [CONTEXT.md](https://github.com/DinhDu002/lr/blob/main/CONTEXT.md). This repository takes two releases from it and nothing else:

- `@dinhdu002/lr-core`, the WebAssembly build of LR's `crates/core` (Keys, addresses, amounts, signatures, transaction ids), a dependency of the packages that use it, pinned to an exact version. It comes from GitHub Packages, so installing needs `NODE_AUTH_TOKEN` with `read:packages`;
- `ghcr.io/dinhdu002/lr-node`, LR's Node image, whose binary the `Dockerfile` copies into the Land image, pinned to a version.

Linked Realms keeps its own Character labels (`characterKey` in `packages/shared`, ADR 0016), and the test vectors that use them in `packages/shared/test-vectors/identity.json`. LR's network ids (test 3, dev 2) are fixed in `packages/shell/src/config.ts`.
