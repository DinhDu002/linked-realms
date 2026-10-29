# AGENTS.md — linked-realms

A game made of many Lands: each player hosts their own Land, and the Lands join into one shared world through the company's Hub, which only connects Lands and lets Characters and NPCs travel. Gold is mined by Proof of Work on the game's own chain, like Bitcoin: every Land runs a Node and can switch its Mines on and off. Players' keys stay in the Shell, and each Land makes its own rules. Test network only. The project owner decides every merge.

## Required

- The full plan is in `PLAN.md`. Before doing anything, read section 2 (principles), section 3 (architecture), section 5 (rules) and the current phase.
- Use the terms defined in `CONTEXT.md`; do not introduce synonyms for them.
- After each completed task, update section 12 (Progress) and the Log in `PLAN.md`.

## Principles that must never be broken

Summary; details in `PLAN.md` section 2.

1. Do not trust Map servers: Gold is decided only by chain rules that every Node checks; a Land cannot change another Land or the chain.
2. No server holds a Player's key. Players' keys stay in the Shell; a server holds only its Map server key and its owner's NPC keys.
3. Every Node checks every Block itself: Proof of Work, signatures and rules.
4. Gold is created only on a fixed schedule: halvings, then a small constant reward per Block forever; no premine.
5. Mining runs only when its owner turns it on, with a CPU limit, and never covertly.
6. A Land's code runs only in an isolated frame; the Shell shows every signing request outside it.
7. Test network only. Never launch a main network.
8. The chain holds only money; Lands, names, items, stats and heavy data live with the Hub or the Lands.
9. Chain rules are defined once in `crates/core`, tested against fixed vectors, and used by the Node, the Mine and the Shell.
10. Transactions and addresses carry a version and a scheme id so they can be extended.

## Conventions

- All repository content is in English: code, comments, documentation, ADRs and commit messages.
- pnpm + Turborepo, TypeScript strict, Vitest. The chain is a Cargo workspace in `crates/` (Rust pinned in `rust-toolchain.toml`), formatted with `cargo fmt` and linted with `cargo clippy`. `packages/core` is the WebAssembly build of `crates/core` (`wasm-bindgen`), built by Turbo before any `typecheck` or `test` that needs it.
- Docker: `compose.yaml` file, `docker compose` command, PostgreSQL `-alpine` images, every image pinned to a version.
- New code must have tests. Run `pnpm test` and `cargo test` before reporting that work is done.
- Do not commit secrets; put sample environment variables in `.env.example`.
- Do not merge into `main` yourself, do not push to the remote, and do not deploy unless asked.
- New architecture decisions: write an ADR in `docs/decisions/`.
- Unclear rules or requirements: ask, do not guess.

## Common commands

Node.js 26 (`.nvmrc`), pnpm 11.3, Rust per `rust-toolchain.toml`, `wasm-bindgen-cli` 0.2.129.

```bash
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm --filter @linked-realms/core build   # the WebAssembly build alone
docker compose up -d
```
