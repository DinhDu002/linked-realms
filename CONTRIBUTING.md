# Contributing

Thanks for your interest in linked-realms.

- The project owner reviews and merges every pull request. Nothing reaches `main` without a pull request.
- Read [PLAN.md](PLAN.md) sections 2 (principles), 3 (architecture) and 5 (rules) first. A change that conflicts with a principle in section 2 will not be merged; open an issue to discuss it instead.
- Use the terms defined in [CONTEXT.md](CONTEXT.md) and, for the chain, [crates/CONTEXT.md](crates/CONTEXT.md).
- Everything in the repository is written in English: code, comments, documentation and commit messages ([Conventional Commits](https://www.conventionalcommits.org/)).
- New code comes with tests. Before opening a pull request, run `pnpm test` and `cargo test`.
- Never commit secrets or private keys. Sample environment variables go in `.env.example`.
- Only the project owner launches the main network (P7): do not add main network deployment configuration.
