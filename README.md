# linked-realms

A multiplayer world made of lands that players host themselves. Lands join into one shared world through the Hub. Characters, land ownership and gold are decided by smart contracts on an EVM testnet, never by the servers that players run.

> **Status:** Phase 0 (foundations). **Testnet only:** nothing in this project has real value.

## Stage 1

- One land per player (64×64 tiles), one main character (every stat equals 1) and one mine.
- Gold (`GOLD`) is mined by Proof of Work. The contract checks every solution itself, and issuance follows a fixed schedule capped at 21 million.
- Characters walk into neighbouring lands through gates.

## Development

Requirements: Node.js 26 (see `.nvmrc`), pnpm 11.3, [Foundry](https://getfoundry.sh) 1.8.6 and Docker.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
(cd contracts && forge test)
docker compose up -d   # PostgreSQL on 127.0.0.1:5432, anvil on 127.0.0.1:8545
```

Copy `.env.example` to `.env` to change the local ports or credentials.

## Documents

- [PLAN.md](PLAN.md): principles, architecture, rules, roadmap and progress.
- [CONTEXT.md](CONTEXT.md): domain glossary.
- [docs/decisions/](docs/decisions/): architecture decision records.
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes get in.

## License

MIT. See [LICENSE](LICENSE).
