# @linked-realms/map-server

The reference Land kit's Map server: one process serves one Land in real time. It is authoritative for movement inside the Land only (P1) and holds no Player's key (P2). Another Land may run any other server that follows the mandatory protocols (`docs/protocols/`).

It does three things:

- serves the Land UI (the built `packages/client`) over HTTP;
- runs the game at `WS /play`, a binary protobuf protocol (`packages/shared/proto/linked_realms/land/v1/land.proto`);
- registers with the Hub and opens the host link to the relay the Hub publishes (`docs/protocols/map-server-hub-relay.md`).

## Run

```bash
LAND_OWNER=tlr1… pnpm --filter @linked-realms/map-server start
```

| Variable                   | Default                               | Meaning                                                                                          |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `LAND_OWNER`               | required                              | The Land owner's Character address                                                               |
| `HUB_TICKET_SIGNER`        | from `GET <hub>/keys`                 | Address of the Hub's ticket key: a ticket's `publicKey` must hash to it                          |
| `HUB_URL`                  | `http://localhost:8787`               | Where this server reaches the Hub                                                                |
| `HUB_DOMAIN`               | host of `HUB_URL`                     | The Hub's host as statements name it; set it when `HUB_URL` uses an internal name                |
| `MAP_SERVER_KEY_FILE`      | `.data/map-server-key` (this package) | The Map server key's seed (see below)                                                            |
| `RELAY_URL`                | from `GET <hub>/keys`                 | `ws://` or `wss://` base URL of the relay; none from either means direct access only             |
| `HOST`                     | `127.0.0.1`                           | Interface to listen on; loopback because the relay agent connects locally                        |
| `PORT`                     | `2567`                                | HTTP and WebSocket port                                                                          |
| `MAP_FILE`                 | `maps/empty-land.json`                | Tiled map, validated at start                                                                    |
| `LAND_UI_DIR`              | `packages/client/dist`                | The built Land UI. If it is missing, pages answer 503 and the start logs a warning               |
| `NODE_ENABLED`             | `true`                                | `false`: no Node, and the Mine is unavailable                                                    |
| `NODE_BIN`                 | `lr-node`                             | The `lr-node` binary this server spawns                                                          |
| `NODE_NETWORK`             | `test`                                | The spawned Node's network: `test` or `dev`                                                      |
| `NODE_SEEDS`               | none                                  | Comma-separated `HOST:PORT` Nodes the spawned Node dials first; without one it has no other Node |
| `MINE_MAX_THREADS`         | none                                  | Lowers the most threads the spawned Node's Mine may run (`lr-node` reads it)                     |
| `NODE_CONTROL_URL`         | none                                  | `ws://HOST:PORT` of a Node this server does not spawn; needs `NODE_CONTROL_SECRET_FILE`          |
| `NODE_CONTROL_SECRET_FILE` | none                                  | That Node's control secret (`--control-secret`), at least 32 bytes                               |

`.env.example` lists the development values. The repository's Docker image runs this server by default, with `MAP_SERVER_KEY_FILE=/data/map-server-key` so the key and the Node's chain live in a volume (`docs/self-hosting.md`), and holds `lr-node` on the `PATH`. The development ticket signer is the address of the seed `0x48` repeated 32 times.

## Start-up

1. **Key and statement.** The server loads the Map server key, or creates it on first start. If `HUB_TICKET_SIGNER` or `RELAY_URL` is unset, it reads `GET /keys` from the Hub, retrying with the same backoff while the Hub is unreachable, and takes the missing values from it (ADR 0010). It then starts listening and posts a fresh `Map server` statement (`Hub`, `Owner`, `Map server key`, `Issued`) to `POST /map-servers`, retrying with backoff from 1 to 30 seconds while the Hub is unreachable. It prints the key's address.
2. **Delegation.** The Land owner signs a Delegation for that key under "Your Land" in the Shell. The Hub then creates the Land.
3. **The Land.** Every 10 seconds the server asks `GET /lands?mapServerKey=<address>`. It serves the Land only if its `owner` is `LAND_OWNER`; otherwise it logs that once and keeps polling. While it waits, it posts a fresh statement every 24 hours, because the Hub forgets one that serves no Land after 7 days.
4. **Relay.** With a relay URL (`RELAY_URL`, or the one the Hub publishes), it connects the relay agent (`connectHost` from `@linked-realms/relay/agent`) as that Land. Without one, the Land is reachable only directly.

SIGINT and SIGTERM close the host link, the sockets and the HTTP server, then stop the Node.

## The Node and the Mine

The Land's Mine runs in its Node (`docs/protocols/map-server-node.md`, ADR 0014). By default this server spawns `NODE_BIN` with `--network NODE_NETWORK --data <dir>/lr-node --control unix:<dir>/lr-node/control.sock --rpc off` and a `--seed` for each of `NODE_SEEDS`, where `<dir>` is the directory of `MAP_SERVER_KEY_FILE` (`/data` in the Docker image). The Node's output goes to this console. If the Node stops, the server starts it again after 1 second, doubling up to 60 seconds; it starts with its Mine off (P5). Exit code 2 (bad settings) and a binary that cannot run are logged and not retried. With `NODE_CONTROL_URL` the server uses that Node instead, sending the secret with the WebSocket upgrade.

The server keeps one WebSocket to the control listener: it subscribes to the Mine (`mine_subscribe`), asks `node_info` every 2 seconds, and tries again every second while the Node cannot be reached. It logs "Mine ON: threads, mode, reward address" when the Mine really runs and "Mine OFF" when it stops. The Mine is `unavailable` while the Node cannot be reached, or while the Mine is off and the Node has no other Node or is not synced; a Mine that runs is reported as running.

## The Map server key

`MAP_SERVER_KEY_FILE` holds the 32-byte seed of an ML-DSA key as 64 lowercase hex characters. It is created on first start with mode 0600 (never overwritten) and refused if it is readable by others or malformed. The key only identifies this Map server to the Hub and the relay; it holds no assets and is not the owner's key. Do not commit it (`.data/` is gitignored).

## The Land UI

`GET` and `HEAD` serve the files of `LAND_UI_DIR`; other methods answer 405.

- `/` is `index.html`, sent with `Cache-Control: no-cache` and an `ETag` (`304` on `If-None-Match`).
- Files under `/assets/` are hashed and sent `public, max-age=31536000, immutable`.
- Dotfiles, paths that leave the directory and directories answer 404.

## `WS /play`

Every frame is one binary protobuf message: `ClientMessage` from the Land UI, `ServerMessage` from this server. A WebSocket upgrade at any other path is rejected.

- **`hello { ticket, arrival }`** must be the first message, within 10 seconds. The server checks it with `verifyHandoff` (`docs/protocols/arrival.md`): the ticket is signed by `HUB_TICKET_SIGNER`, is for this Land, is neither expired nor too far ahead, was issued after this process started, and was not used before; the arrival is signed by the ticket's Character for this Land and nonce. The nonce is remembered until the ticket expires and is recorded only when every check passes.
- **`welcome { you, land, map, characters }`** answers an accepted hello. `characters` holds everyone present, the newcomer included. Others get `joined`. The Character appears one tile inside the arrival Gate, or at the map's spawn point for Gate 0. `is_owner` is the Hub's owner, `name` is the ticket's `Name` (the Land UI shows the short address when it is empty) and `driven_by_ai` comes from the arrival.
- **`input { dx, dy, seq }`**, with `dx` and `dy` in -1, 0, 1. A 20 Hz tick moves every Character with the shared `step()` and sends `moved { positions, seq }` with only the Characters that moved. `seq` is the receiver's last applied `input` seq; a Character that is blocked still gets a `moved` with its new `seq` and no positions.
- **`left { id }`** is sent to the others when a Character leaves.
- **`mine_state`** goes to each Character after `welcome` and whenever the Node's state changes, about every 2 seconds while the Mine is on. The Land owner's copy also holds this session's challenge and the Map server key's address; the challenge is renewed at once when it is spent or 300 seconds old.
- **`mine_switch { signed }`** from the Land owner, a Land message signed in the Shell, is checked in the order of "Checks, in order" (`docs/protocols/map-server-node.md`) and answered with `mine_switch_result { ok, code }`. Only then does the server call `mine_start`, with the Land owner's address and mode `auto`, or `mine_stop`.
- **`mine_won`** goes to every Character when the Node reports a Block its Mine found (`mine_blockFound`).
- **`error { code, message }`**, then close code 1008. Codes: the `arrival.md` codes (`bad-ticket`, `wrong-land`, `expired`, `too-far-ahead`, `before-start`, `reused`, `bad-arrival`, `key-mismatch`, `mismatch`), `full` (64 Characters), `duplicate` (one session per address), `rate-limited` (more than 30 inputs in a second), `bad-message` (not a binary protobuf frame, an unexpected message, or a bad `dx` or `dy`) and `unavailable` (the Land is not known yet).

## Tests

`pnpm --filter @linked-realms/map-server test` runs `land.test.ts` on raw WebSockets against a real server (real ML-DSA keys from fixed seeds, a fake clock), plus the config, key file and Hub client tests (stub Hub). `land.test.ts` also refuses a switch for each check with a fake Node; `node.test.ts` runs the control client against a fake control listener on a Unix socket and on TCP, and supervises a fake `lr-node` script.
