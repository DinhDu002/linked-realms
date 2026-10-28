# Phase 1C — Connectivity and travel between Lands

Status: done, 2026-10-29. The project owner waived the per-step approval gate for this run (PLAN.md section 11); this file is the plan of record.

**Done when** (PLAN.md section 6): three Map servers run in three separate containers; a Player walks through a Gate from Land A to Land B; shutting down A makes the Directory show it as offline.

Decisions are recorded in `docs/decisions/0004-hub-relay-and-travel.md`. Connection rules come from PLAN.md section 3.5 and `docs/research/2026-10-29-connection-scaling.md`.

## Flows

1. **Registering a Land.** The Map server prints its Mining key address. The Land owner, in the client, signs a **Delegation** (EIP-712) naming that address and posts it to `hub-api`. `hub-api` checks that the signer owns the Land on-chain (`Land.ownerOf`, smart-wallet signatures included via viem `verifyTypedData` on a public client) and stores the newest Delegation per Land. A Map server identifies itself only with its Mining key (P2); the Land owner's key never leaves their wallet.
2. **Hosting.** The Map server opens one outbound WebSocket to the relay (`/host/<landId>`), answers a challenge by signing it with its Mining key, and the relay accepts the link only if that address is the Land's current Delegation in the Directory and the Land is not hidden. Players never need to open a port.
3. **Sign-in.** The client signs in to `hub-api` with SIWE (viem `createSiweMessage` / `verifySiweMessage`) and gets a short-lived session token.
4. **Entering a Land.** The client asks `hub-api` for a Travel ticket for Land B. `hub-api` checks that the Player has a Character (on-chain), that B is in the Directory, not hidden and online, and, for travel through a Gate, that B is adjacent to the Land the Player comes from. It signs a ticket (EIP-712) valid for 60 seconds. The client joins B through the relay with the ticket; the Map server verifies it offline (signer, Land, expiry, single use) and spawns the Character at the arrival Gate.
5. **Online status** comes from the relay: a Land is online while its Map server's link to the relay is open (section 3.5 rule 4). `hub-api` reads the relay's list of online Lands; there are no heartbeats from Map servers to `hub-api`.
6. **Abuse.** A signed-in Player reports a Land; an admin (an address in `HUB_ADMINS`, signed in with SIWE) hides it, which removes it from the Directory and makes the relay drop and refuse its link.

## Shared definitions (`packages/shared`)

- `src/hub.ts`:
  - `HUB_EIP712_DOMAIN(chainId)` = `{ name: "linked-realms Hub", version: "1", chainId }`.
  - `DelegationTypes`: `Delegation { landId: uint256, miningKey: address, issuedAt: uint64 }`.
  - `TravelTicketTypes`: `TravelTicket { player: address, landId: uint256, gate: uint8, expiresAt: uint64, nonce: bytes32 }`; `gate` is the arrival Gate (`GATE_NONE = 0`, north 1, east 2, south 3, west 4).
  - `TRAVEL_TICKET_TTL_SECONDS = 60`.
  - `verifyTravelTicket({ ticket, signature, hubSigner, landId, nowSeconds })` → the ticket or throws `JoinRejected` (reused from `join.ts`); pure, offline (viem `recoverTypedDataAddress`).
  - Directory types: `DirectoryLand { landId, owner, x, y, miningKey, online }`, `Directory { relayUrl, lands }`.
  - `relayLandUrl(relayUrl, landId)` = `<relayUrl>/land/<landId>` (the Colyseus endpoint for a Land, section 3.5 rule 1).
- `src/rules/world.ts` (rules, generated into the map):
  - `GATE_WIDTH_TILES = 2`, centred on each edge (tiles 31–32), on the edge row or column.
  - `gateOf(map, position)` → the Gate direction whose tiles the Character's box overlaps, or `undefined`.
  - `neighbourOf(x, y, direction)` → adjacent world coordinates (north is `y - 1`, east `x + 1`).
  - `arrivalGate(direction)` → the opposite side; `gateSpawn(map, gate)` → the position one tile inside that Gate.
- `src/map`: `parseLandMap` requires exactly one `gate` object per direction (`type: "gate"`, property `direction`), each lying on its edge; Gates are walkable. `maps/empty-land.json` is regenerated with them (P6: maps stay data).
- `src/protocol.ts`: `JoinOptions` becomes `{ ticket, signature }`; the EIP-191 join message from Phase 1A is removed.

## Packages

### `packages/hub-api` (Hono on `@hono/node-server`, viem, PostgreSQL via `pg`; tests on PGlite)

Config: `PORT` (8787), `DATABASE_URL`, `RPC_URL`, `CHAIN_ID`, `RELAY_PUBLIC_URL` (what clients use), `RELAY_INTERNAL_URL` (what `hub-api` polls), `HUB_TICKET_KEY` (signs Travel tickets; a server key, not a Player's), `HUB_SESSION_SECRET`, `HUB_ADMINS` (comma-separated addresses), `HUB_ALLOWED_ORIGINS` (CORS).

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /auth/nonce` | — | SIWE nonce (single use, 5 minutes) |
| `POST /auth/verify` | — | `{ message, signature }` → `{ token, address, expiresAt }` |
| `GET /directory` | — | `Directory`; `Cache-Control: public, s-maxage=5, stale-while-revalidate=30` |
| `GET /directory/:landId` | — | one `DirectoryLand` or 404 |
| `POST /lands/:landId/delegation` | — | `{ miningKey, issuedAt, signature }` signed by the Land owner |
| `POST /tickets` | session | `{ landId, from? }` → `{ ticket, signature }` |
| `POST /reports` | session | `{ landId, reason }` (reason ≤ 500 characters), rate-limited per address |
| `GET /admin/reports` | admin session | open reports |
| `POST /admin/lands/:landId/hidden` | admin session | `{ hidden: boolean }` |
| `GET /health` | — | `ok` |

Land owner and coordinates are read from the chain when a Delegation is registered (`ownerOf`, `coordinatesOf`); Lands are soulbound, so they never change. Online status: `GET <RELAY_INTERNAL_URL>/online`, cached for 2 seconds. Tables: `delegation (land_id pk, owner, x, y, mining_key, issued_at, signature, hidden, updated_at)`, `report (id, land_id, reporter, reason, created_at, resolved)`. Migrations are plain SQL run at start-up.

### `packages/relay` (Node.js + `ws`)

Config: `PORT` (8080), `HUB_URL` (to read Delegations), `MAX_CLIENTS_PER_LAND` (64), `MAX_HOSTS` (1000).

- `GET /online` → `{ lands: number[] }`; `GET /stats` → per-Land and per-session byte and message counters (rule 6); `GET /health`.
- `WS /host/<landId>`: the Map server link. Challenge → `hello` signed with the Mining key (EIP-191, `linked-realms relay: host Land <id>\nNonce: <nonce>`) → checked against `GET <HUB_URL>/directory/<landId>` (`miningKey`, not hidden). A second link for the same Land replaces the first. Pings every 15 s; a link that misses two is closed.
- `POST|GET|OPTIONS /land/<landId>/matchmake/...` and other HTTP under `/land/<landId>/`: forwarded over the host link with the `/land/<landId>` prefix stripped (Colyseus routes `/matchmake/:method/:roomName` exactly). Body limit 64 KiB; 503 when the Land is offline; CORS headers come from the Map server's response.
- `WS /land/<landId>/<processId>/<roomId>?...`: a Player connection, forwarded over the host link. Client frames are capped at 16 KiB (≥ Colyseus's 4,096-byte `maxPayload`, rule 7); compression is off on every socket; a client whose send buffer passes 1 MiB is closed (bounded buffering).
- **Host link protocol** (`src/protocol.ts`, shared by the relay and the agent): JSON text frames for control — `challenge`, `hello`, `ready`, `http` / `http-response` (body base64), `open` (stream id, path), `close` (stream id, code). Binary frames for data: 4-byte big-endian stream id, 1 byte (0 = binary, 1 = text), payload.
- **Agent** (`src/agent.ts`, exported as `@linked-realms/relay/agent`, used by `map-server`): `connectHost({ relayUrl, landId, privateKey, localPort, log }) → { close(): Promise<void> }`. It answers the challenge, opens a local WebSocket to `ws://127.0.0.1:<localPort><path>` for each `open`, runs `http` requests against `http://127.0.0.1:<localPort>`, and reconnects with backoff (1 s doubling to 30 s) until closed.
- **Load test** (rule 8): `load/land.js`, a k6 script (`grafana/k6:2.3.0`, a Go client, not JavaScript in Node) that opens N Player WebSockets to a test Land and exchanges 20 messages per second each way; `scripts/load-host.ts`, a stub Map server that links as that Land and echoes and broadcasts without Colyseus. README records how to run it and the first baseline numbers.

### `packages/map-server`

- `RELAY_URL` (optional; without it the server is reachable only directly, for development), `HUB_TICKET_SIGNER` (the address whose tickets it accepts), `HOST` (default `127.0.0.1`: the relay agent connects locally).
- Join: `verifyTravelTicket` replaces the EIP-191 message; ticket nonces are remembered until they expire (single use); the spawn point is `gateSpawn` for the ticket's Gate, or the map's spawn for `GATE_NONE`.
- Starts the relay agent when `RELAY_URL` is set.

### `packages/client`

- Config: `VITE_HUB_URL` replaces `VITE_MAP_SERVER_URL` and `VITE_LAND_ID`.
- Sign in with SIWE after connecting the wallet. A Directory panel lists Lands with online status; "Enter" asks for a ticket and joins through the relay.
- Gates: when the Character stands on a Gate, the client looks up the neighbouring Land in the Directory; if it is online it gets a ticket (`from` = current Land), leaves, and joins the neighbour; otherwise it shows "No Land to the east" or "Land 7 is offline" once until the Character steps off the Gate.
- Land owner: under "Your Land", "Register Map server" takes the Mining key address the Map server prints at start-up, signs the Delegation and posts it. It does not need the Land to be entered: the relay refuses a Map server until it is registered, so the first registration cannot happen from inside the Land (found in the browser check; the first build had the button inside the Land).
- "Report this Land" with a reason.

### Containers and end-to-end (`compose.yaml`, `Dockerfile`)

- One `Dockerfile` (`node:26.12.1-alpine3.24`, pnpm 11.3.0) builds the monorepo image used by `hub-api`, `relay` and the Map servers. It runs as a non-root user.
- `compose.yaml` keeps `docker compose up -d` as today (PostgreSQL and anvil). The `world` profile adds: `deploy` (one-shot `forge script` on the anvil; checks that the addresses match `packages/shared/src/deployments/31337.json`, without writing to the repo), `seed` (one-shot: creates Characters for anvil dev accounts 1–3, which receive Lands 1, 2 and 3 at (0, 0), (1, 0) and (1, 1); writes a Mining key into each Map server's volume; signs and posts their Delegations), `hub-api`, `relay`, `map-1`, `map-2`, `map-3`. Dev-only keys come from anvil's public test mnemonic and are labelled as such.
- `packages/map-server/scripts/seed-world.ts` is the `seed` service's script. `packages/map-server/scripts/world-e2e.ts` (root `pnpm e2e:world`): a Player (anvil dev account 4) signs in, enters Land 1 through the relay, walks east through the Gate into Land 2, and checks the arrival Gate; then `docker compose stop map-1` and waits until the Directory shows Land 1 offline; then starts `map-1` again and waits until it is online.

## Verification

1. `pnpm test`: ticket and Delegation signing and verification, gate rules and map validation, `hub-api` routes on PGlite, relay forwarding with a fake host and real WebSockets, the agent against a real relay, the room's ticket checks.
2. `forge test` unchanged.
3. `pnpm e2e:world` against `docker compose --profile world up -d`: the Done-when scenario.
4. The k6 load test against the stub host: a recorded baseline.
5. In the browser: sign in, enter Land 1 through the relay, walk into Land 2.
