# AGENTS.md — linked-realms

A game made of many Lands: each player hosts their own Land, and the Lands join into one shared world through the company's Hub, which only connects Lands and lets Characters and NPCs travel. Gold is mined by Proof of Work on LR, the project's own chain, like Bitcoin: every Land runs a Node and can switch its Mines on and off. Players' keys stay in the Shell, and each Land makes its own rules. The main network starts after step 2C. The project owner decides every merge.

## Required

- The full plan is in `PLAN.md`. Before doing anything, read section 2 (principles), section 3 (architecture), section 5 (rules) and the current phase.
- Use the terms defined in `CONTEXT.md` (the game) and LR's glossary (<https://github.com/DinhDu002/lr/blob/main/CONTEXT.md>; LR is the chain); `CONTEXT-MAP.md` says which covers what. Do not introduce synonyms for them.
- LR, the chain, is not in this repository: it lives in <https://github.com/DinhDu002/lr> (ADR 0017). The game uses its releases, the package `@dinhdu002/lr-core` and the image `ghcr.io/dinhdu002/lr-node`.
- After each completed task, update section 12 (Progress) and the Log in `PLAN.md`.

## Principles that must never be broken

Summary; details in `PLAN.md` section 2.

1. Do not trust Map servers: Gold is decided only by chain rules that every Node checks; a Land cannot change another Land or the chain.
2. No server holds a Player's key. Players' keys stay in the Shell; a server holds only its Map server key and its owner's NPC keys.
3. Every Node checks every Block itself: Proof of Work, signatures and rules.
4. Gold is created only on a fixed schedule: halvings, then a small constant reward per Block forever; no premine.
5. Mining runs only when its owner turns it on, with a CPU limit, and never covertly.
6. A Land's code runs only in an isolated frame; the Shell shows every signing request outside it.
7. The main network starts after step 2C, only the project owner launches it, and it is never reset; rules change only through network upgrades.
8. The chain holds only money; Lands, names, items, stats and heavy data live with the Hub or the Lands.
9. Chain rules are defined once in LR's `crates/core` (DinhDu002/lr; the game takes it as `@dinhdu002/lr-core`), tested against fixed vectors, and used by the Node, the Mine and the Shell.
10. Transactions and addresses carry a version and a scheme id so they can be extended.

## Conventions

- All repository content is in English: code, comments, documentation, ADRs and commit messages.
- pnpm + Turborepo, TypeScript strict, Vitest. `@dinhdu002/lr-core` is pinned to an exact version and comes from GitHub Packages; `lr-node` comes from LR's image, pinned in the `Dockerfile`.
- Docker: `compose.yaml` file, `docker compose` command, PostgreSQL `-alpine` images, every image pinned to a version.
- New code must have tests. Run `pnpm test` before reporting that work is done.
- Do not commit secrets; put sample environment variables in `.env.example`.
- Do not merge into `main` yourself, do not push to the remote, and do not deploy unless asked.
- New architecture decisions: write an ADR in `docs/decisions/`.
- Unclear rules or requirements: ask, do not guess.

## Common commands

Node.js 26 (`.nvmrc`), pnpm 11.3. Installing and building need `NODE_AUTH_TOKEN`, a token with `read:packages` (GitHub Packages asks for one even for a public package), e.g. `export NODE_AUTH_TOKEN=$(gh auth token)`; never write it to a file.

```bash
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
docker compose up -d   # builds with the same token, as a BuildKit secret
```
