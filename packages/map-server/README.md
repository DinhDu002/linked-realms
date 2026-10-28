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
| `MINING_KEY_FILE`    | `.data/mining-key` (in this package) | The Mining key file (see Mining) |
| `MINING_MAX_THREADS` | CPU cores minus one, at least 1      | Upper limit for mining threads   |

`pnpm e2e` runs a manual end-to-end check against a local anvil (creates two Characters, starts
the server on port 2601, joins with two SDK clients, then stops the server).

## Mining

The Map server can mine GOLD for its Land owner (P5):

- Mining is **off** at every start. Only the Land owner's session can switch it on or off (room
  message `mining`, `{ on, threads }`); other sessions are ignored. `threads` is clamped to
  `MINING_MAX_THREADS`.
- The room state `mining` shows on/off, threads, hash rate, Round and Solutions to everyone on
  the Land, and the console logs when mining is on. It keeps running while the Land is empty.
- The Mining key is created on first start in `MINING_KEY_FILE` (mode 0600, never committed). It
  is not the owner's key and holds no assets: it only pays the fees for submitting Solutions.
  The server prints its address and ETH balance at start-up, never the key. On anvil it is
  topped up automatically; on any other chain, fund the printed address from a faucet.
- Rewards always go to the Land owner's wallet, read from the chain at start-up (P2).

`pnpm e2e:mining` runs two Map servers against a local anvil whose contracts were deployed with
`DEV_ROUND_SECONDS` and `DEV_RETARGET_INTERVAL_ROUNDS`, and checks rewards and Round time.
