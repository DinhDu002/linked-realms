# Phase 2 — Open source and testing (testnet)

Status: built, 2026-10-29; waiting for the project owner (D5 choice, Base Sepolia deployment) and for outside Land hosts (Done-when). The project owner waived the per-step approval gate for this run (PLAN.md section 11); this file is the plan of record.

**Goal** (PLAN.md section 6): people outside the team can host their own Land and play reliably.

**Done when:** at least 10 Lands hosted by people outside the team stay connected reliably for one week. That needs real people and a public testnet world, so it cannot be completed in this run; this plan delivers everything they need, and the runbook the project owner follows to open the world.

## Work items

### 1. Self-hosting a Land

- The `Dockerfile` from Phase 1C becomes the self-hosting image: its default command runs the Map server (with the miner), the Mining key lives in the `/data` volume, and every setting comes from environment variables. The Hub, relay and seed services keep naming their own command.
- A self-hoster runs one command (`docker run ... --env-file land.env -v ...:/data <image>`). The image is not published yet: publishing to a registry is an outward-facing step for the project owner. Until then the guide builds it straight from the public repository (`docker build <git URL>`), which needs no clone.
- `docs/self-hosting.md`: what a Land host needs (Docker, a Character and Land made in the client, a little testnet ETH for the Mining key's fees), the `land.env` settings, the one command, registering the Mining key from the client, switching mining on (P5: only the owner, only on request, with a thread limit and an optional `--cpus` limit), updating, moving to another machine, stopping, and troubleshooting by log line.
- CI builds the image on every pull request (no push), so a broken `Dockerfile` cannot reach `main`.
- Verified by running the guide's command against the local world (`world` compose profile) for a new Land and registering it from the client.

### 2. Dashboard

PLAN.md asks for: Lands online, mines mining, estimated hash rate, Round time, winner distribution. It is served by the indexer, which already holds the mining history (section 3.1), at `GET /dashboard` as plain server-rendered HTML (no client code, P6 does not apply).

| Figure | Source | Definition |
|---|---|---|
| Lands online | `hub-api` `GET /directory` (`HUB_URL`, optional) | Lands whose Map server is linked to the relay now; "unknown" without `HUB_URL` or if the Hub does not answer within 2 s |
| Mines mining | `round_won` | Distinct reward wallets that won a Round in the last 24 hours. Only the chain is trusted (P1), so this counts Lands proven to be mining; a Land too slow to win in a day is not counted |
| Round time | `round_won` | Mean time between the last 100 won Rounds |
| Estimated hash rate | `GoldMine.target()` and Round time | `(2^256 / target) / Round time`: expected hashes per Solution over seconds per Solution |
| Winner distribution | `round_won` joined to `land` on owner | Rounds won per Land over the last 1,000 Rounds, with share; the top 20 and "others" |

The computation is a pure function with unit tests; the route only queries and renders.

### 3. Embedded wallet and paymaster (D5)

Research and a proposed ADR, then wait for the project owner's choice (owner's instruction for this run). `docs/research/2026-10-29-embedded-wallet.md` and `docs/decisions/0005-embedded-wallet.md` (status: proposed). PLAN.md D5 records "proposed, waiting for the owner". No wallet code until the owner chooses.

### 4. Opening the testnet world (runbook for the project owner)

The owner deploys to Base Sepolia (owner's instruction for this run: anvil only for Claude). `docs/runbooks/base-sepolia.md`:

1. Deploy the contracts with a Foundry keystore account (`pnpm --filter contracts deploy:base-sepolia`), commit `packages/shared/src/deployments/84532.json` and register it in `deployments/index.ts`.
2. Run `hub-api`, the relay and PostgreSQL on a server with TLS, from the same image, with real secrets generated on the server (never committed).
3. Run the indexer (dashboard) against Base Sepolia.
4. Build and host the client for chain 84532.
5. The Stage 1 test on three machines, as a checklist.

## Verification

1. `pnpm test`, `forge test`, Slither: green.
2. Image built locally and in CI; the self-hosting command run for a new Land in the local world, registered from the client, online in the Directory.
3. Dashboard: unit tests for the figures; the route run against a local chain with won Rounds and checked in the browser.
