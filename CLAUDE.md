# CLAUDE.md — linked-realms

A game made of many lands: each player hosts their own land, and the lands join into one shared world through the company's Hub. Stage 1 has one land, one character (every stat equals 1) and one gold mine mined by Proof of Work like Bitcoin; a character can walk into other players' lands. EVM blockchain, testnet only. The project owner decides every merge.

## Required

- The full plan is in `PLAN.md`. Before doing anything, read section 2 (principles), section 3 (architecture), section 5 (rules) and the current phase.
- Use the terms defined in `CONTEXT.md`; do not introduce synonyms for them.
- After each completed task, update section 12 (Progress) and the Log in `PLAN.md`.

## Principles that must never be broken

Summary; details in `PLAN.md` section 2.

1. Do not trust map servers: everything that affects other players is decided by smart contracts.
2. No server holds a player's main private key. A map server uses only its own mining key, which holds no assets; rewards always go to the land owner's wallet.
3. The contract checks the Proof of Work solution itself before paying a reward.
4. Gold is created only on a fixed issuance schedule, with a capped total supply.
5. Mining runs only when the player actively turns it on, with a CPU limit, and never covertly.
6. Maps are data; the client never runs code received from another server.
7. Testnet only. Never deploy to mainnet.
8. Rules are defined once in `packages/shared/src/rules`; the contracts and `miner` must produce matching results.
9. Character stats and object types are stored as key–value pairs so they can be extended.

## Conventions

- All repository content is in English: code, comments, documentation, ADRs and commit messages.
- pnpm + Turborepo, TypeScript strict, Vitest. Contracts use Foundry + OpenZeppelin and are upgradeable via UUPS.
- Docker: `compose.yaml` file, `docker compose` command, PostgreSQL `-alpine` images, every image pinned to a version.
- New code must have tests. Run `pnpm test` and `forge test` before reporting that work is done.
- Do not commit secrets; put sample environment variables in `.env.example`.
- Do not merge into `main` yourself, do not push to the remote, and do not deploy unless asked.
- New architecture decisions: write an ADR in `docs/decisions/`.
- Unclear rules or requirements: ask, do not guess.

## Common commands

Update after Phase 0.

```bash
pnpm install
pnpm test
cd contracts && forge test
docker compose up -d
```
