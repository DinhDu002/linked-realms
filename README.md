# linked-realms

A multiplayer world made of lands that players host themselves. Lands join into one shared world through the Hub. Characters, land ownership and gold are decided by smart contracts on an EVM testnet, never by the servers that players run.

> **Status:** Phase 2 (open testing). **Testnet only:** nothing in this project has real value.

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

Run the game locally (each command in its own terminal):

```bash
pnpm --filter @linked-realms/contracts deploy:local   # deploy to anvil; writes packages/shared/src/deployments/31337.json
LAND_ID=1 pnpm --filter @linked-realms/map-server dev  # the Map server for Land 1 on ws://127.0.0.1:2567
pnpm --filter @linked-realms/client dev                # the game on http://127.0.0.1:5173
```

In the game, choose "Use dev wallet" (anvil only), create a Character, then enter Land 1. Open a second browser profile to see two Players on the same Land.

Mining is off until the Land owner switches it on in the game (1 CPU thread by default). To watch Retargets within minutes instead of hours, deploy to a fresh anvil with shorter Rounds, then run the two-Map-server mining check:

```bash
DEV_ROUND_SECONDS=5 DEV_RETARGET_INTERVAL_ROUNDS=10 pnpm --filter @linked-realms/contracts deploy:local
pnpm --filter @linked-realms/map-server e2e:mining
```

After changing a rule in `packages/shared/src/rules`, run `pnpm --filter @linked-realms/shared generate`; after changing a contract, run `forge build` in `contracts/` and `pnpm --filter @linked-realms/shared export-abi`.

## Run the world

The `world` profile adds the Hub, the relay and three Map servers (one Land each) to the default services, so a Player can walk from Land to Land. Run it as its own Compose project, so it never touches the state of a default stack:

```bash
pnpm install   # the deploy step reads contracts/node_modules
ANVIL_PORT=8546 POSTGRES_PORT=5433 docker compose -p linked-realms-world --profile world up -d --build
pnpm e2e:world   # sign in, walk from Land 1 into Land 2, stop and restart Land 1's Map server
docker compose -p linked-realms-world --profile world down -v   # reset everything
```

| Service    | What it is                                                                                                                  | Host port                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `anvil`    | Local chain                                                                                                                 | `ANVIL_PORT` (8545)         |
| `postgres` | The Hub's database                                                                                                          | `POSTGRES_PORT` (5432)      |
| `deploy`   | One-shot: deploys the contracts on a copy of the repo and fails if the addresses differ from `packages/shared/src/deployments/31337.json` | none                        |
| `hub-api`  | Directory, sign-in, Travel tickets, reports                                                                                 | `HUB_PORT` (8787)           |
| `relay`    | Carries Players to Map servers that have no open port                                                                       | `RELAY_PORT` (8080)         |
| `seed`     | One-shot: Characters for anvil accounts 1 to 3 (Lands 1, 2, 3 at (0, 0), (1, 0), (1, 1)), a Mining key per Map server, signed Delegations posted to the Hub | none                        |
| `map-1..3` | One Map server per Land; each links out to the relay and keeps its Mining key in its own volume                             | none                        |

Run the client against it with `VITE_RPC_URL=http://127.0.0.1:8546 VITE_HUB_URL=http://127.0.0.1:8787 pnpm --filter @linked-realms/client dev` (the RPC port is `ANVIL_PORT`). "Use dev wallet" makes a key in the browser and funds it on anvil; "Create Character" then gives it a Land, which you can host with the steps in [docs/self-hosting.md](docs/self-hosting.md) (on the world's network: add `--network linked-realms-world_default` and use `CHAIN_ID=31337`, `RPC_URL=http://anvil:8545`, `RELAY_URL=ws://relay:8080`, and `HUB_TICKET_SIGNER` from `compose.yaml`). The dev accounts 1 to 3 own Lands 1 to 3.

**All keys here are public test keys.** They come from anvil's well-known mnemonic (`test test ... junk`), including `HUB_TICKET_KEY` (account 9) and the session secret in `compose.yaml`. They exist for local development only; never reuse them anywhere else. Anvil keeps no state across restarts: after restarting only `anvil`, run `down -v` so the Hub's database matches the new chain.

## Documents

- [PLAN.md](PLAN.md): principles, architecture, rules, roadmap and progress.
- [CONTEXT.md](CONTEXT.md): domain glossary.
- [docs/decisions/](docs/decisions/): architecture decision records.
- [docs/self-hosting.md](docs/self-hosting.md): host your own Land with Docker.
- [docs/runbooks/base-sepolia.md](docs/runbooks/base-sepolia.md): open the testnet world (project owner).
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes get in.

## License

MIT. See [LICENSE](LICENSE).
