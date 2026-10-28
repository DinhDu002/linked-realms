# linked-realms

A multiplayer world made of lands that players host themselves. Lands join into one shared world through the Hub. Characters, land ownership and gold are decided by smart contracts on an EVM testnet, never by the servers that players run.

> **Status:** Phase 0 (foundations). **Testnet only:** nothing in this project has real value.

## Stage 1

- One land per player (64×64 tiles), one main character (every stat equals 1) and one mine.
- Gold (`GOLD`) is mined by Proof of Work. The contract checks every solution itself, and issuance follows a fixed schedule capped at 21 million.
- Characters walk into neighbouring lands through gates.

## Documents

- [PLAN.md](PLAN.md): principles, architecture, rules, roadmap and progress.
- [CONTEXT.md](CONTEXT.md): domain glossary.
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes get in.

## License

MIT. See [LICENSE](LICENSE).
