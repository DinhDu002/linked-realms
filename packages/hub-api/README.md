# @linked-realms/hub-api

The Hub's HTTP API (Hono on `@hono/node-server`, PostgreSQL). It registers Lands, gives them cells, keeps the Directory and Characters' names, signs Travel tickets and takes abuse reports. It holds no Player's key and touches no chain. Design: `docs/plans/phase-2b-world-without-chain.md`; protocols: `docs/protocols/`.

## Run

```bash
cp .env.example .env   # dev values only
pnpm --filter @linked-realms/hub-api start
```

Migrations run at start-up (`src/db.ts`, plain SQL, tracked in the `migration` table). Needs PostgreSQL and, for online status, the relay. Signatures and addresses come from `@linked-realms/core` (the WebAssembly build of `crates/core`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `HUB_TICKET_KEY` | required | 32-byte ML-DSA-44 seed in hex that signs Travel tickets; it grants entry only and holds no assets. Its address is printed at start and published at `GET /keys`, where Map servers read it |
| `HUB_SESSION_SECRET` | required | HS256 secret for session tokens, at least 32 characters |
| `PORT` | 8787 | |
| `HUB_DOMAIN` | `localhost:8787` | This Hub's host: the `Hub:` line every statement must carry |
| `RELAY_INTERNAL_URL` | `http://127.0.0.1:8080` | Read for `GET /online` |
| `RELAY_PUBLIC_URL` | unset | `ws://` or `wss://` URL of the relay as Map servers dial it, published at `GET /keys`; unset publishes `null` |
| `LAND_BASE_DOMAIN` / `LAND_URL_SCHEME` | `localhost:8080` / `http` | Land URLs: `<scheme>://<landId>.<base domain>` |
| `HUB_ADMINS` | empty | Comma-separated `tlr1…` addresses that may hide Lands |
| `HUB_ALLOWED_ORIGINS` | empty | Comma-separated CORS origins (the Shell's) |
| `HUB_TRUSTED_PROXIES` | empty | IPs or CIDRs of the reverse proxy in front of the Hub. Empty: the client is the socket's peer. Set: behind such a peer, the client is the rightmost `X-Forwarded-For` entry that is not a trusted proxy |

## Routes

Errors are `{ "error": "..." }`. Session routes take `Authorization: Bearer <token>`. Signed statements travel as `{ statement, publicKey, signature }` (`docs/protocols/identity.md`).

| Method and path | Auth | |
|---|---|---|
| `GET /health` | — | `ok` |
| `GET /keys` | — | `{ ticket: { address, publicKey }, relayUrl }`: Map servers take the ticket signer and the relay from it unless they pin them (ADR 0010) |
| `POST /auth/verify` | — | A sign-in statement with `Issued` within 60 s of the Hub's clock, used once. Returns `{ token, address, name, expiresAt }` (1 hour) |
| `PUT /me/name` | session | `{ name }`: trimmed, 1–32 code points, no control or format characters |
| `POST /map-servers` | signature | A Map server statement within 5 minutes of the Hub's clock. `204`; `409` if a newer one from the key exists |
| `GET /map-servers?owner=` | session (that owner) | `{ mapServers: [{ mapServerKey, issued }] }`: keys that named this Character and serve no Land |
| `POST /lands` | signature | A Delegation. Creates the Land (`201 { landId }`) or, for an owner who has one, replaces its Map server key with a newer Delegation (`200`; the registered one sent again gets the same answer). `403` unless that key's Map server statement names this owner; `409` if the key serves another Land or a newer Delegation exists; `429` past 3 new Lands per network address per day |
| `GET /lands/:landId`, `GET /lands?owner=`, `?mapServerKey=` or `?domain=` | — | A visible Land's `LandInfo`, with or without a cell; `404` otherwise. `url` is the own domain when one is set |
| `PUT /lands/:landId/domain` | session (the owner) | `{ domain }` sets the Land's own domain once its DNS TXT record `_linked-realms.<domain>` is `land=<landId>`; `{ domain: null }` removes it. `400` for a port, a wildcard, an IP address or a name without a dot; `409` when the record does not name the Land or another Land it still names uses the domain; `503` when DNS does not answer (`docs/protocols/map-server-hub-relay.md`, Land URLs) |
| `GET /tls/allowed?domain=` | — | `200` only for the own domain of a visible Land with a cell; Caddy's on-demand TLS `ask` (`deploy/Caddyfile`) |
| `GET /directory` | — | `{ lands }`: the visible Lands that have a cell |
| `POST /tickets` | session | `{ landId, from? }` returns a signed Travel ticket. `404` for an unknown or hidden Land; `409` when it has no cell, is offline or is not adjacent to `from` |
| `POST /reports` | session | `{ landId, reason }` |
| `GET /admin/reports`, `POST /admin/lands/:landId/hidden` | admin | |

**The sweep** runs every 15 seconds (`src/sweep.ts`): it records which Lands the relay has online, gives online Lands without a cell one (a new Land takes the lowest free spiral index, a Land that lost its cell the edge), takes the cell of a Land not seen online for 30 days, forgets quota rows after 2 days and Map server statements that serve no Land after 7, and reads each own domain's TXT record again once a day (50 per sweep). A domain whose record no longer names its Land is dropped; one whose DNS does not answer is kept and asked again an hour later.

**Limits:** sign-ins 30 per minute and Map server statements and Delegations 10 per minute per network address (IPv4, or IPv6 /64); tickets 30 per minute, own domain changes 10 per minute and reports 5 per hour per Character.

## Limits of this design

- Used sign-in nonces, rate limits and the presence cache live in process memory, so one `hub-api` process only. With several nodes, move them to Redis.
- Reports have no "resolve" route yet: `GET /admin/reports` lists every report whose `resolved` flag is false, and nothing sets it.

## Tests

`pnpm --filter @linked-realms/hub-api test`: every route and the sweep against PGlite (in-process PostgreSQL) with a fake relay, clock, network address and DNS.
