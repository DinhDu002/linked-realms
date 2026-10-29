# linked-realms

A game made of many Lands. Each player hosts their own Land, and the Lands join into one shared world through the Hub, which only connects Lands and lets Characters travel between them. Gold is mined by Proof of Work on the game's own chain, like Bitcoin. Players' keys stay in the Shell, and each Land makes its own rules.

> **Status:** Phase 2, step 2B: the world without the chain. The chain, the Node and the Mine come in step 2C. **Test network only:** nothing in this project has real value.

## Stage 1

- Each Character owns at most one Land (64×64 tiles). The Hub gives every Land a cell, and Characters walk into neighbouring Lands through Gates.
- Gold is mined by Proof of Work on the game's own chain. Every Node checks every Block, and Gold is created only on a fixed schedule, with no premine.
- A Player's key never leaves the Shell. A Land's UI runs in an isolated frame, and the Shell shows the Player every signature a Land asks for.

## Play

The test world runs at <https://play.linkedrealms.com>. Open it, make a Character, and walk into the Lands in the Directory: with the arrow keys on a computer, or with the pad in the lower left on a phone or tablet. "Full screen" in the bar hides the browser around the game; on an iPhone, which has no full screen for pages, add the Shell to the Home Screen and open it from there. To host a Land of your own, install Docker on a computer (phones cannot run it) and run the one command the Shell shows under "Your Land" ([docs/self-hosting.md](docs/self-hosting.md)). For now this test world serves Lands 1 to 4.

## Development

Requirements: Node.js 26 (see `.nvmrc`), pnpm 11.3, Rust through `rustup` (the version is pinned in `rust-toolchain.toml`) with `wasm-bindgen-cli` 0.2.129, and Docker.

```bash
cargo install wasm-bindgen-cli --version 0.2.129 --locked
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test   # builds packages/core (WebAssembly) first
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
docker compose up -d   # PostgreSQL on 127.0.0.1:5432
```

Copy `.env.example` to `.env` to change the local ports or credentials. The Shell's browser tests are `pnpm --filter @linked-realms/shell test:browser` (`packages/shell/README.md`).

## Run the world

The `world` profile adds the Hub, the relay, the Shell and two Map servers to PostgreSQL. Run it as its own Compose project, so it never touches the state of a default stack:

```bash
POSTGRES_PORT=5433 docker compose -p linked-realms-world --profile world up -d --build
pnpm e2e:world   # register both Lands, walk from Land 1 through a Gate into Land 2, stop and restart Land 1
docker compose -p linked-realms-world --profile world down -v   # reset everything
```

| Service    | What it is                                                                                      | Host port              |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| `postgres` | The Hub's database                                                                              | `POSTGRES_PORT` (5432) |
| `hub-api`  | Land registration, cells, the Directory, sign-in, names, Travel tickets, reports                | `HUB_PORT` (8787)      |
| `relay`    | Carries Players to Map servers that have no open port; Land `n` is `http://n.localhost:8080`     | `RELAY_PORT` (8080)    |
| `shell`    | The Shell                                                                                       | `SHELL_PORT` (8788)    |
| `map-1`    | Development Character 1's Map server; it keeps its Map server key in its own volume             | none                   |
| `map-2`    | Development Character 2's Map server                                                            | none                   |

With other ports or another project name, give `pnpm e2e:world` the same `HUB_PORT` and `SHELL_PORT`, and the project as `WORLD_PROJECT`.

To play by hand, open the Shell at <http://localhost:8788>, choose "Restore from 24 words" and enter a development Character's words. Under "Your Land", "Register" gives that Character its Land; within about 15 seconds the Land has a cell and is online in the Directory. A browser profile holds one Character, so use a second profile for the second Character.

| Development Character | Owns    | 24 words                                                                                                                                                                                  |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                     | `map-1` | `absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice comic`                    |
| 2                     | `map-2` | `acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount exchange`                  |
| Admin (`HUB_ADMINS`)  | —       | `adapt blossom school alcohol coral light army gather adapt blossom school alcohol coral light army gather adapt blossom school alcohol coral light army hold`                            |

**All keys here are public development keys:** these Characters, the Hub's ticket key and session secret in `compose.yaml`. They exist for local development only; never reuse them anywhere else.

To host a Land of your own against this world, follow [docs/self-hosting.md](docs/self-hosting.md) on the world's network: add `--network linked-realms-world_default` and use `HUB_URL=http://hub-api:8787`, `HUB_DOMAIN=localhost:8787` and `RELAY_URL=ws://relay:8080`.

## Documents

- [PLAN.md](PLAN.md): principles, architecture, rules, roadmap and progress.
- [CONTEXT.md](CONTEXT.md): domain glossary.
- [docs/decisions/](docs/decisions/): architecture decision records.
- [docs/protocols/](docs/protocols/): the protocols every Land, Shell and Hub follows.
- [docs/self-hosting.md](docs/self-hosting.md): host your own Land with Docker.
- [docs/runbooks/public-world.md](docs/runbooks/public-world.md): run a public world (Hub, relay and Shell).
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes get in.

## License

MIT. See [LICENSE](LICENSE).
