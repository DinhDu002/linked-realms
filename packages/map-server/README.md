# @linked-realms/map-server

The Map server: one process runs exactly one Land in real time (Colyseus 0.18, room `land`).
It is authoritative for movement inside the Land only. Anything that affects other Players is
decided on-chain (P1).

- Joining needs a signed join message (see `joinMessage` in `@linked-realms/shared`) from a
  wallet that has a Character. The server never holds a Player's key (P2).
- Sends the map text and the Land info to each client after joining; the client validates the
  map with `parseLandMap` (P6).
- Moves Players at 20 Hz with the shared `step`; the Mine blocks movement. At most 30 input
  messages per second per client are used.

## Run

```bash
LAND_ID=1 pnpm --filter @linked-realms/map-server start
```

| Variable   | Default                    | Meaning                          |
| ---------- | -------------------------- | -------------------------------- |
| `LAND_ID`  | required                   | The Land this process serves     |
| `PORT`     | `2567`                     | WebSocket port                   |
| `RPC_URL`  | `http://127.0.0.1:8545`    | JSON-RPC endpoint                |
| `CHAIN_ID` | `31337`                    | Selects the shared deployment    |
| `MAP_FILE` | `maps/empty-land.json`     | Tiled map, validated at start-up |

`pnpm e2e` runs a manual end-to-end check against a local anvil (creates two Characters, starts
the server on port 2601, joins with two SDK clients, then stops the server).
