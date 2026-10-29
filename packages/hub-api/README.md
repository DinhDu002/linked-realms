# @linked-realms/hub-api

The Hub's HTTP API (Hono on `@hono/node-server`, viem, PostgreSQL). It keeps the Directory of Lands, registers Delegations, signs Travel tickets and takes abuse reports. Design: `docs/plans/phase-1c-connectivity.md` and `docs/decisions/0004-hub-relay-and-travel.md`.

## Run

```bash
cp .env.example .env   # dev values only
pnpm --filter @linked-realms/hub-api start
```

Migrations run at start-up (`src/db.ts`, plain SQL, tracked in the `migration` table). Needs PostgreSQL, an RPC node with the contracts deployed (`packages/shared/src/deployments`) and, for online status, the relay.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `HUB_TICKET_KEY` | required | Signs Travel tickets; a server key that holds no assets. Map servers set `HUB_TICKET_SIGNER` to its address |
| `HUB_SESSION_SECRET` | required | HS256 secret for session tokens, at least 32 characters |
| `PORT` | 8787 | |
| `RPC_URL` / `CHAIN_ID` | `http://127.0.0.1:8545` / 31337 | |
| `RELAY_PUBLIC_URL` | `http://127.0.0.1:8080` | Returned in the Directory; what clients use |
| `RELAY_INTERNAL_URL` | `http://127.0.0.1:8080` | Polled for `GET /online` |
| `HUB_SIWE_DOMAIN` | `localhost:5173` | The domain SIWE messages must name |
| `HUB_ADMINS` | empty | Comma-separated addresses that may hide Lands |
| `HUB_ALLOWED_ORIGINS` | empty | Comma-separated CORS origins |
| `HUB_BUNDLER_URL` | unset | ERC-4337 bundler and ERC-7677 paymaster endpoint (CDP); a secret, since the URL holds the API key. Unset: `POST /aa` answers 503 |

## Routes

`GET /health`, `GET /auth/nonce`, `POST /auth/verify`, `GET /directory`, `GET /directory/:landId`, `POST /lands/:landId/delegation`, `POST /tickets`, `POST /reports`, `POST /aa`, `GET /admin/reports`, `POST /admin/lands/:landId/hidden`. Errors are `{ "error": "..." }` with no stack traces or RPC details. Protected routes take `Authorization: Bearer <token>`.

Notes on behaviour:

- `POST /auth/verify` returns `{ token, address, expiresAt }` (unix seconds, 1 hour).
- `POST /lands/:landId/delegation` takes `{ miningKey, issuedAt, signature }` (`issuedAt` in unix seconds, decimal string or integer). Answers 403 if the signature is not the Land owner's, 409 if a Delegation with an equal or newer `issuedAt` exists, 404 for a Land that does not exist.
- `POST /tickets` takes `{ landId, from? }` and answers `{ ticket, signature }` (ticket in wire format, see `ticketToWire`). 403 without a Character or for non-adjacent Lands, 404 for an unregistered or hidden Land, 409 when the Land is offline.
- Hidden Lands answer 404 on `GET /directory/:landId`, which is how the relay refuses their link.
- `POST /aa` (ADR 0005) is a JSON-RPC proxy to `HUB_BUNDLER_URL` for a signed-in Player's Passkey wallet. It forwards `eth_estimateUserOperationGas`, `eth_sendUserOperation`, `eth_getUserOperationReceipt`, `pm_getPaymasterStubData` and `pm_getPaymasterData`, and answers the bundler's JSON-RPC reply as is. A user operation is refused unless it uses EntryPoint v0.6, comes from the session's own address, deploys (if at all) through the Coinbase Smart Wallet v1.1 factory, and makes only the calls in `SPONSORED_CALLS` with no ETH value (403); `createCharacter()` is refused for a Player who has a Character (409). Sponsored transactions are counted in the `sponsorship` table when the paymaster signs: 20 per Player and 10,000 for the world per UTC day (429).
- Rate limits per address: tickets 30 per minute, reports 5 per hour, `/aa` 120 per minute (every attempt counts, valid or not).

## Limits of this design

- SIWE nonces, rate limits and the presence cache live in process memory, so one `hub-api` process only. With several nodes, move them to Redis.
- Reports have no "resolve" route yet: `GET /admin/reports` lists every report whose `resolved` flag is false, and nothing sets it.
- Signatures are checked through viem's public client (`verifySiweMessage`, `verifyTypedData`), so smart-contract wallets work; tests inject offline verifiers using local accounts.

## Tests

`pnpm --filter @linked-realms/hub-api test`: every route against PGlite (in-process PostgreSQL) with fake chain reads, relay presence and clock.
