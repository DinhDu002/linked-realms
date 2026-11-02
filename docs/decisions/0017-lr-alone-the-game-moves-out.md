# 0017 — LR alone: the game moves out

Status: accepted, 2026-11-02 — by the project owner, who chose the repository split, the names `DinhDu002/lr` and `DinhDu002/linked-realms`, keeping the Shell's wallet part as LR's web wallet, the connect-agent for the game, and the chain-only gate. The wallet's labels (decision 3) and decisions 5 and 6 were filled in by Claude under the owner's go-ahead for the split, and await their review. It changes ADR 0015 (decision 6, the direction of the split, and step 2C's Done-when) and ADR 0016 (decision 4: the package name takes effect now, and the Land image is no longer built here).

ADRs 0001–0005, 0007, 0008, 0010 and 0014 named in this file are Linked Realms' (this repository, [`docs/decisions/`](.)). The chain's ADRs 0011–0013 are LR's: [`docs/decisions/` at `v0.1.0`](https://github.com/DinhDu002/lr/tree/v0.1.0/docs/decisions). This file is copied to both repositories, as ADR 0015 was.

## Context

ADR 0015 made the chain a product of its own, LR, and planned for LR to move out of this repository at the end of step 2C, with `git filter-repo`, before the genesis. On 2026-11-02 two things changed the picture:

- A teammate's Hub v1 (closed source, written in Go) replaced `hub-api` on `hub.linkedrealms.com`. Linked Realms will join it through that teammate's connect-agent, using only the agent's local loopback contract. The game's server side therefore changes: this repository's `hub-api`, relay and Shell no longer fit the Hub that runs, and they are stopped. LR does not change.
- LR's services run on the test network already (network id 3): the seed `seed.linkedrealms.com:9444`, the Public node `https://rpc.linkedrealms.com` and the archive from `deploy/compose.chain.yaml`, and the Checkpoint signer on the project owner's machine from `deploy/compose.signer.yaml`. Checkpoint 10 was signed that day.

What stayed in this repository was the chain and a game that depended on it, and the larger half of the history was the game's. The cheaper split is the reverse of ADR 0015's: keep this repository for LR, and cut the game out.

## Decisions

1. **This repository becomes LR alone and is renamed `DinhDu002/lr`.**
   - It holds the chain (`crates/`), its WebAssembly package (`packages/core`), the company's chain services (`deploy/compose.chain.yaml`, `deploy/compose.signer.yaml`), the `lr-node` image, and LR's web wallet (`packages/wallet`, decision 3).
   - The pre-split history is tagged `pre-split`. The glossary of `crates/CONTEXT.md` moves to `CONTEXT.md`, now the only one; there is no `CONTEXT-MAP.md`.
   - Rejected: keeping the game here until it has a new Hub, which leaves a game that cannot run in a repository that has to publish a chain.
2. **The game moves to a new public repository, `DinhDu002/linked-realms`, cut from this history with `git filter-repo` at the tag `pre-split`.**
   - It is the reverse of ADR 0015 decision 6, which moved LR out. The game keeps its history, its plans, its ADRs 0001–0005, 0007, 0008, 0010 and 0014, and the Land image `linked-realms-node`.
   - It consumes LR as releases: `@dinhdu002/lr-core` and `ghcr.io/dinhdu002/lr-node` (decision 5). It joins Hub v1 through the connect-agent, not through code from this repository.
   - The Land image is no longer built here. ADR 0016 decision 4 left it named `linked-realms-node`; that is now only Linked Realms' artifact.
   - Rejected: moving LR out as ADR 0015 planned. The chain's history would be the part to cut, and the game's CI, images and deployed services would stay in a repository that no longer matches them.
3. **The web wallet stays with LR and derives its key with LR's labels.**
   - `packages/wallet` (`@dinhdu002/lr-wallet`) is the wallet part of the old Shell: it keeps a key behind a password, shows the balance, and signs and sends Gold. Everything about Lands, the Hub and frames is gone from it.
   - It derives its key as `accountKey(entropy, 0)` in `@dinhdu002/lr-core`: the salt `lr/ml-dsa-44/v1` and the info `account/0`. Linked Realms keeps its Character labels, `linked-realms/ml-dsa-44/v1` and `character/{index}`, in its own repository (ADR 0016 decision 1).
   - So the same 24 words give a different address in the wallet than a Linked Realms Character. The 115 test GOLD mined to the Character Du-1 stays at that Character's address on the test network; the wallet does not see it. Test Gold is worth nothing.
   - An application may choose its own labels; LR gives it no reason to use another application's.
   - Rejected: the wallet deriving with the game's labels, which would put the game's name into LR's wallet. Rejected: deleting the wallet, which leaves LR with no way to hold and send Gold.
4. **The gate before the main network is a chain-only test, in place of step 2C's Done-when.**
   - On the test network, three people on three different machines each run `lr-node mine`, each wins Blocks, they send Gold to one another with the wallet, and the Checkpoint signer keeps signing Checkpoints throughout.
   - Then only the project owner launches the main network (P7, unchanged): a genesis without premine, the main network's id, the `lr` prefix and the Checkpoint end height 1,051,200.
   - The old Done-when needed Lands, a Hub and walking through Gates; none of them is LR's. The three-Player check of the old runbook needs a Hub this repository's Shell could use, which no longer exists.
   - Rejected: keeping the game in the gate, which makes LR's launch wait on a Hub that a teammate owns.
5. **LR publishes what the game consumes.**
   - `@dinhdu002/lr-core`, the WebAssembly build of `crates/core`, on GitHub Packages, which takes a package only under its owner's scope (ADR 0016 decision 4). The name takes effect now: `packages/core` is already `@dinhdu002/lr-core`.
   - `ghcr.io/dinhdu002/lr-node`, the image of the Dockerfile's `lr-node` target, the last stage and so the default.
   - The first release is v0.1.0 (PLAN.md section 6).
6. **What else is fixed by the split.**
   - The CI job `typescript` keeps its name: it is `main`'s required status check.
   - `deploy/compose.chain.yaml` keeps `name: linked-realms-chain`: the live Caddy vhost proxies to the container `linked-realms-chain-public-1`, and Caddy joined that network by hand.
   - `compose.yaml` becomes LR's local development, on the dev network, as the compose project `lr`.
   - Linked Realms' labels, statements and protocols (`identity.md`'s Signed statements, the Mine switch and `land.proto` of the old `map-server-node.md`) go with the game. LR keeps the Node's control listener, in `docs/protocols/node-control.md`, described for any program that drives a Node.

## Consequences

- ADR 0015 decisions 6 and 4 change as above; its other decisions stand. ADR 0016 decision 4 is carried out. Their Status lines say so.
- Step 2C's items 28 and 29 and its Done-when are replaced by PLAN.md section 6 (the split, v0.1.0, the chain-only test, the launch). `docs/plans/phase-2c-the-chain.md` stays as history, with a note.
- PLAN.md section 2 is rewritten for LR as a draft: only the project owner may edit it, so it applies once they approve it, and until then P1–P10 of 2026-10-30 apply to LR's parts. The numbers P1–P10 are kept so that references in code still resolve; P6 is replaced.
- Nothing about the chain changes: the rules, the vectors, the networks and the running services are the same, and no network is reset.
- The Gold on the Du-1 Character's address (decision 3) is out of reach of the wallet, but not lost: the Linked Realms repository holds the Character labels that derive it.
- LR's first release has one consumer, Linked Realms, whose repository does not exist until the cut is done; until then the package and the image have none.
