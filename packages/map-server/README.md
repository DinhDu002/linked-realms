# @linked-realms/map-server

The Map server: one process runs exactly one Land in real time (Colyseus 0.18, room `land`).
It is authoritative for movement inside the Land only. Anything that affects other Players is
decided on-chain (P1).

- Joining needs a **Travel ticket** signed by the Hub (EIP-712, `TravelTicketTypes` in
  `@linked-realms/shared`). The server checks it offline with `verifyTravelTicket`: signed by
  `HUB_TICKET_SIGNER`, for this Land, not expired. A ticket can be used once (its nonce is
  remembered until it expires), and an address can be in the Land only once. The Hub has already
  checked that the wallet has a Character, so the server does not ask the chain. The server never
  holds a Player's key (P2).
- A ticket names the arrival Gate: the Character spawns one tile inside that Gate, or at the
  map's spawn point when the ticket has no Gate.
- Sends the map text and the Land info (including the Mining key address, so the Land owner can
  register it with the Hub) to each client after joining; the client validates the map with
  `parseLandMap` (P6).
- Moves Players at 20 Hz with the shared `step`; the Mine blocks movement. At most 30 input
  messages per second per client are used.

## Run

```bash
LAND_ID=1 pnpm --filter @linked-realms/map-server start
```

| Variable   | Default                    | Meaning                          |
| ---------- | -------------------------- | -------------------------------- |
| `LAND_ID`  | required                   | The Land this process serves     |
| `HUB_TICKET_SIGNER` | required          | Address of the Hub key whose Travel tickets are accepted |
| `HOST`     | `127.0.0.1`                | Interface to listen on           |
| `RELAY_URL` | unset                     | `ws://` or `wss://` URL of the relay; unset = direct access only |
| `PORT`     | `2567`                     | WebSocket port                   |
| `RPC_URL`  | `http://127.0.0.1:8545`    | JSON-RPC endpoint                |
| `CHAIN_ID` | `31337`                    | Selects the shared deployment    |
| `MAP_FILE` | `maps/empty-land.json`     | Tiled map, validated at start-up |
| `MINING_KEY_FILE`    | `.data/mining-key` (in this package) | The Mining key file (see Mining) |
| `MINING_MAX_THREADS` | CPU cores minus one, at least 1      | Upper limit for mining threads   |

## Hub and relay

Players reach a Land through the Hub (PLAN.md section 3.5, `docs/decisions/0004-hub-relay-and-travel.md`):

1. The Land owner registers this server's Mining key with the Hub by signing a Delegation in the
   client: they paste the address the server prints at start-up (`Mining key created: 0x…`) into
   "Register Map server" under their Land. Until then the relay refuses the link (4404) and the
   agent keeps retrying, at most every 30 seconds.
2. With `RELAY_URL` set, the server opens one outbound link to the relay as this Land
   (`connectHost` from `@linked-realms/relay/agent`), proving itself by signing a challenge with
   the Mining key. The relay accepts it only if that key is the Land's Delegation in the Hub. No
   inbound port is needed, and the server stays on loopback by default because the agent connects
   locally. The start-up log says whether the Land is reachable only directly or also through
   the relay.
3. A Player asks the Hub for a Travel ticket and joins through the relay with it.

Without `RELAY_URL` the Land is reachable only directly (development); tickets are still required,
so for a local run set `HUB_TICKET_SIGNER` to the address of a key you control and sign tickets
with it (the e2e scripts do this with a throwaway key).

`pnpm e2e` runs a manual end-to-end check against a local anvil (creates two Characters, starts
the server on port 2601, joins with two SDK clients using tickets signed by a throwaway key standing in for the Hub, then stops the server).

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
