# Step 2B — World without the chain

Status: approved, 2026-10-29, by the project owner, who took the recommended answer to every question below (1 A; 32-byte addresses; BIP-39 seed then HKDF-SHA512; Argon2id; the listed libraries; Rust installed here, and `deploy/` plus the runbook written for a server and domains the owner provides). Being built on branch `phase-2/2b-world`.

**Done when** (PLAN.md section 6, step 2B): two people on two machines run their own Lands, register them with the Hub without any Gold and walk through a Gate into each other's Land; a test shows that a Land's UI cannot read the Shell's keys or sign without the Player's approval.

Decisions come from ADR 0007 (the world off the chain) and ADR 0008 (the Shell and open Lands), and principles P2, P6, P8, P9 and P10. The encodings in "Identities and signed statements" are hard to reverse, because the chain reuses them in 2C. They go into ADR 0009 once approved. Branch `phase-2/2b-world`, made from `design/own-chain`.

## Flows

1. **Creating a Character.**
   - The Shell draws 32 random bytes with `crypto.getRandomValues`, shows them as 24 words and asks the Player to confirm three of them.
   - It derives the ML-DSA-44 key and its address, and stores the 32 bytes encrypted with the Player's password.
   - The 24 words are asked for only on the Shell's setup page, which never contains a Land's frame. To restore, the Player types the words there.
   - Nothing reaches the Hub or the chain.
2. **Signing in to the Hub.**
   - The Shell signs a sign-in statement with a nonce of its own and the current time, and posts it with its public key. There is no challenge to fetch first.
   - The Hub checks the signature and that `Issued` is within 60 seconds of its clock. It remembers verified nonces for 2 minutes and refuses repeats.
   - It derives the address from the public key and returns a session token valid for 1 hour.
   - The token is kept in memory only. After a reload, unlocking the Shell signs in again without asking.
3. **Naming a Character.**
   - The Player sets a name in the Shell (free, at most 32 characters, not unique).
   - The Hub stores it and returns it at sign-in, in the Directory and in Travel tickets.
   - The Shell shows it next to the address (see "Address").
4. **Registering a Land.**
   1. The Land owner copies their address from the Shell into the Map server's `LAND_OWNER` setting.
   2. On first start the Map server creates its Map server key in its data volume. It signs a Map server statement naming that owner, posts it to the Hub, and prints the key's address.
   3. In the Shell, "Your Land" lists the Map servers that named this Character. The Land owner picks one and signs a Delegation for it, which the Shell posts to the Hub.
   4. The Hub accepts the Delegation only if a Map server statement from that key names the same owner. That proves the key's holder agreed, so nobody can claim someone else's Map server.
   5. The Hub enforces one Land per Character and at most 3 new Lands per network address per day. It creates the Land with a new Land id and no cell.
   - A later Delegation from the same Character with a newer time replaces the Map server key, for example when the Land moves to another machine.
5. **Hosting.**
   - The Map server asks the Hub every 10 seconds for the Land that names its key. It serves that Land only if the owner is its `LAND_OWNER`.
   - It then opens one outbound WebSocket to the relay and answers the relay's challenge with its Map server key.
   - The relay accepts the link only if that key is the Land's current Delegation and the Land is not hidden. A Land without a cell can connect, since it needs to be online to get one. The Land owner opens no port.
6. **Getting a cell.** Every 15 seconds the Hub reads the relay's list of online Lands.
   - A registered Land that is online and has no cell gets one.
     - A new Land takes the lowest free spiral index.
     - A Land that lost its cell takes the index after the highest one in use: the edge of the spiral.
   - Only Lands with a cell appear in the Directory.
   - "Online" in the Directory and in ticket checks is the relay's live list, cached for 2 seconds as today. The sweep only records `last_online_at`.
7. **Entering a Land.**
   1. The Player picks a Land in the Shell's Directory.
   2. The Shell asks the Hub for a Travel ticket.
   3. The Shell signs an arrival statement that binds the ticket's nonce and says whether an AI drives the Character. The Shell always says no; NPC runners say yes in 2E.
   4. The Shell opens the Land UI in a cross-origin iframe at the Land's URL, as the Directory gives it, and hands the frame the ticket and the arrival statement over a `MessageChannel`.
   5. The Land UI sends both to its Map server as its first message. The Map server checks them offline and places the Character at the arrival Gate. Without a Gate (the ticket's Gate is 0), it uses the map's spawn point.
8. **Travelling through a Gate.**
   - When the Character steps on a Gate, the Land UI sends `travel { direction }` to the Shell.
   - The Shell finds the neighbouring cell in the Directory and asks for a ticket with `from` set to the current Land. It signs a new arrival statement and loads the neighbour's frame.
   - If no Land is there, or it is offline, the Shell tells the frame, which shows "No Land to the east" or "Land 7 is offline".
9. **Losing a cell.**
   - A Land not seen online for 30 days loses its cell.
   - Its row, Land id and Delegation stay, so it returns at the edge (flow 6).
   - The 15-second sweep is the accuracy limit on "30 days in a row".
10. **Abuse.**
    - A signed-in Player reports a Land from the Shell's own controls, not from inside the frame.
    - An admin (an address in `HUB_ADMINS`) hides it. A hidden Land leaves the Directory, the relay drops its link within 30 seconds, and its own domain stops getting certificates.
11. **A Land asks for a signature.** In 2B the only signing request a Land can make is `signMessage { text }`.
    - The Shell builds the statement itself and shows it in a prompt outside the frame (see `packages/shell`). It signs only when the Player approves.
    - Payment requests are defined in the spec but refused until 2C.

## Identities and signed statements (ADR 0009)

- **Keys.** Every key is ML-DSA-44 (FIPS 204): Characters, Map server keys and the Hub's ticket key, so one verifier serves every party.
  - Signing is hedged. The 32 random bytes come from the OS, or from `crypto.getRandomValues` in the Shell.
  - Every signature uses an ML-DSA context string naming its purpose, so a signature made for one purpose never verifies for another.
- **Character key from 24 words.**
  1. 32 bytes of `entropy` become 24 BIP-39 words (English list).
  2. The BIP-39 seed is PBKDF2-HMAC-SHA512 with 2048 rounds and an empty passphrase.
  3. `xi = HKDF-SHA512(salt = "linked-realms/ml-dsa-44/v1", ikm = seed, info = "character/0", 32 bytes)`.
  4. `ML-DSA-44.KeyGen(xi)`.
  - No standard covers BIP-39 to ML-DSA. This is our own profile, fixed by test vectors.
  - The index in `info` lets one set of words hold more Characters later, for NPCs in 2E.
- **Map server key and the Hub's ticket key:** 32 random bytes of `xi`, stored on the server. They are never derived from words.
- **Address.**
  - Bech32m (BIP-350) with the prefix `tlr` (test network) over `version (0) ‖ scheme (1 = ML-DSA-44) ‖ keccak256(scheme ‖ public key)`. That is a 34-byte payload, about 65 characters, starting `tlr1`.
  - The version and scheme id satisfy P10.
  - The full 32-byte hash keeps quantum preimage resistance in line with the reason for choosing ML-DSA.
  - Because the first characters after `tlr1` are the same for every address, the Shell shows `Name (tlr1` + the first 6 and last 6 varying characters + `)`. Payments in 2C will show the full address.
- **Signed statements** are UTF-8 text in a fixed grammar, specified in `identity.md` with vectors for each rule:
  - The first line names the statement.
  - Then, in exactly the order listed below, one `Key: value` line per key. No key is repeated, missing or extra.
  - Lines are split on `\n` only.
  - A value must not contain control, format, line-separator or paragraph-separator characters (Unicode Cc, Cf, Zl, Zp) or unpaired surrogates. This also covers names, so the Hub refuses such names.
  - Free text from a Land travels as the last line, `Message: <JSON string>`.
  - On the wire a statement is `{ statement, publicKey, signature }`, with the last two in base64.
  - A verifier checks the signature first, then parses strictly. Land messages, Delegations and Map server statements name their signer, so the verifier checks that the address derived from `publicKey` is that one; for the other statements the protocol checks the address (`identity.md`).

| Statement | Signed by | Context | Lines after the first |
|---|---|---|---|
| `linked-realms Hub sign-in` | Character | `linked-realms/hub-sign-in/v1` | `Hub`, `Nonce`, `Issued` |
| `linked-realms Map server` | Map server key | `linked-realms/map-server/v1` | `Hub`, `Owner`, `Map server key`, `Issued` |
| `linked-realms Delegation` | Land owner | `linked-realms/delegation/v1` | `Hub`, `Owner`, `Map server key`, `Issued` |
| `linked-realms Travel ticket` | Hub's ticket key | `linked-realms/travel-ticket/v1` | `Hub`, `Character`, `Name`, `Land`, `Gate`, `Issued`, `Expires`, `Nonce` |
| `linked-realms arrival` | Character | `linked-realms/arrival/v1` | `Land`, `Ticket nonce`, `Driven by AI` (`yes` or `no`) |
| `linked-realms relay host` | Map server key | `linked-realms/relay-host/v1` | `Relay`, `Land`, `Nonce` |
| `linked-realms Land message` | Character | `linked-realms/land-message/v1` | `Land`, `Land URL`, `Character`, `Issued`, `Message` (JSON string, at most 1,000 characters) |

- **Why arrival needs no extra round trip.** The Hub's ticket nonce is the arrival challenge: fresh, used once and bound to one Land. Signing it proves the arriving party holds the Character's key.
- **Why the AI field is in the arrival statement.** The flag is self-declared (ADR 0008), so the Character signs it; the Hub does not vouch for it.

## Mandatory protocols (`docs/protocols/`, written first)

- **`identity.md`:** keys, addresses, the statement grammar and contexts, with the vector files from `crates/core/test-vectors/`. A Land in another language implements against these.
- **`shell-land-ui.md`:** the Shell ↔ Land UI API (`api: 1`).
  - **Connection.** After the frame's `load` event, the Shell posts `{ type: "linked-realms/connect", api: 1 }` to the Land's exact origin and transfers a `MessagePort`. All traffic then goes over that port. The Land UI accepts the port only from `window.parent`.
  - **Shell to frame:**
    - `init { land, character { address, name }, arrival { ticket, statement } }`
    - `travelRefused { reason }`
    - `signResult { id, signature | error }`
  - **Frame to Shell:**
    - `travel { direction }`: at most 1 per second.
    - `signMessage { id, text }`: one at a time. A 10-second cooldown follows a refusal, and after 3 refusals the Land cannot ask again until it is reloaded.
    - `pay { id, amount, recipient, memo }`: reserved, refused with `unsupported` until 2C.
  - Unknown types are ignored, and messages over 64 KiB are dropped.
- **`arrival.md`:** the checks a Land makes, in order:
  1. the ticket's signature, by a key whose address is the configured Hub ticket key (`HUB_TICKET_SIGNER`);
  2. `Land` is this Land, and `Gate` is between 0 and 4;
  3. `Expires` is in the future and at most 120 seconds ahead;
  4. `Issued` is not before the Map server started, so a restart that forgets nonces cannot accept a replayed ticket;
  5. the nonce has not been used, remembered until it expires;
  6. the arrival's signature;
  7. the address derived from its public key equals the ticket's `Character`;
  8. the arrival's `Land` and `Ticket nonce` match the ticket.

  It also covers where Gate 0 places the Character (the Land's own spawn), how a Land shows "driven by AI", and the error codes.
- **`map-server-hub-relay.md`:**
  - the Hub routes a Map server uses: `POST /map-servers`, `GET /lands?mapServerKey=`, and `GET /keys`, which publishes the Hub's ticket key for operators;
  - the host link: the challenge, the `relay host` hello, control and data frames, HTTP stream frames (below) and pings;
  - Land URLs: `<landId>.<LAND_BASE_DOMAIN>` or the owner's own domain;
  - the headers the relay adds.
- **`gate-travel.md`:** the `travel` message, `POST /tickets` with `from`, and the arrival Gate numbering (north 1, east 2, south 3, west 4; 0 means no Gate).
- **Not here:** Map server ↔ Node over JSON-RPC follows in 2C. The reference kit's game protocol (`.proto`) is a reference, not mandatory, and lives with the kit.

## `crates/` (Cargo workspace, new)

- **Workspace.**
  - Root `Cargo.toml`, and `rust-toolchain.toml` pinning the stable release current at implementation.
  - `targets = ["wasm32-unknown-unknown"]` and the `rustfmt` and `clippy` components.
  - `target/` goes into `.gitignore`, `.prettierignore` and the eslint ignores.
- **`crates/core`** (`linked-realms-core`), first part.
  - **Dependencies:**
    - `fips204` 0.5, with `default-features = false` and the `ml-dsa-44` feature;
    - `bip39` 3, with `alloc`: entropy in, words out, no `rand`;
    - `hkdf` 0.13 with `sha2`;
    - `sha3` (keccak256);
    - `bech32`;
    - `wasm-bindgen` =0.2.129, behind a `wasm` feature;
    - dev-dependencies: `ml-dsa` =0.1.1 for the cross-check, and `serde_json` and `hex` for the vectors.
  - **API:**
    - `words_from_entropy`, `entropy_from_words` (checks the checksum);
    - `character_key(entropy, index)`, `key_from_seed(xi)`, `public_key`;
    - `sign(context, message, rnd)`, `verify(scheme, public_key, context, message, signature)`;
    - `address(scheme, public_key)`, `Address::parse` and `Display`.
  - **Tests:**
    - NIST ACVP ML-DSA-44 keyGen (25 cases) and sigVer (the external, pure cases), vendored as filtered JSON with the source commit and NIST's notice;
    - `ml-dsa` gives the same public key from the same seed, and each crate verifies the other's signatures;
    - the BIP-39 reference vectors;
    - our own vectors in `test-vectors/identity.json`, which TypeScript tests read too: words → seed → `xi` → public key → address, one signed statement per context, and the grammar's rejection cases (a repeated key, an extra line, U+2028 in a name, a bidi character);
    - rejection of a wrong context, a wrong scheme, a flipped bit and a bad checksum.
- **`packages/core`** (`@linked-realms/core`, new): the WASM build of `crates/core`.
  - Built with `cargo build --target wasm32-unknown-unknown --release`, then `wasm-bindgen --target web` into `pkg/`. `pkg/` is git-, prettier- and eslint-ignored.
  - A small wrapper loads it with `init()` in browsers and with `initSync()` and the file's bytes in Node.
  - Turbo gains a `build` task:
    - `inputs`: `crates/**`, `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml`;
    - `outputs`: `pkg/**`;
    - `typecheck` and `test` depend on `^build`, and on `build` for `packages/core` itself.
  - The WASM size is measured and recorded in the README.

## Packages

### `packages/shared`

- **`src/identity.ts`:** builds and strictly parses the seven statements.
  - `verifyStatement({ statement, publicKey, signature }, kind)` returns the fields or throws, using `@linked-realms/core`.
  - Its tests read `crates/core/test-vectors/identity.json`.
  - `verifyHandoff` runs the checks of `arrival.md` in order.
- **`src/hub.ts`:**
  - `LandInfo { landId, owner, ownerName, x, y, url, mapServerKey, online }` and `LandDirectory { lands }`, where `x` and `y` are null without a cell.
  - These new names sit beside the old `DirectoryLand`, `Directory`, `relayLandUrl` and EIP-712 types, so every commit typechecks. The old names go in item 7 of the order of work.
  - The Gate numbering and `TRAVEL_TICKET_TTL_SECONDS = 60` stay.
- **Game protocol (reference):** `proto/linked_realms/land/v1/land.proto`.
  - `ClientMessage { hello { ticket, arrival }, input { dx, dy, seq } }`.
  - `ServerMessage { welcome { you, land, map }, joined, left, moved[], notice, error }`, where `moved` lists only the Characters that moved this tick.
  - Field numbers for mining are reserved for 2C.
  - Code is generated with `buf` and `protoc-gen-es` into `src/gen/`, which is committed and excluded from prettier and eslint. A CI `buf` job regenerates it, fails on a diff, and runs `buf lint`.
- **Stays:** `rules/world.ts` (spiral, Gates, neighbours), `map/` and `movement.ts`. `maps/empty-land.json` becomes hand-maintained data once its generator is deleted.
- **Deleted** in item 8, once their last user is gone:
  - `abi/`, `deployments/`, `chain.*`, `format.*`;
  - `codegen/`, `scripts/generate.ts`, `scripts/export-abi.ts`;
  - `rules/mining.*`, `rules/sponsorship.ts`, and `rules/character.ts` (no shared stats, ADR 0007);
  - `test-vectors/mining.json`, `test-vectors/spiral.json`;
  - the mining parts of `protocol.ts`, and `viem`.

### `packages/hub-api`

**Config:**

| Setting | Status | Notes |
|---|---|---|
| `PORT`, `DATABASE_URL`, `HUB_SESSION_SECRET`, `HUB_ALLOWED_ORIGINS`, `RELAY_INTERNAL_URL` | kept | |
| `HUB_DOMAIN` | new | Replaces `HUB_SIWE_DOMAIN`. It is the `Hub:` line in statements. |
| `HUB_TICKET_KEY` | changed | A 32-byte ML-DSA seed in hex |
| `HUB_ADMINS` | changed | `tlr1…` addresses |
| `LAND_BASE_DOMAIN`, `LAND_URL_SCHEME` | new | Land URLs; in development, `localhost:8080` and `http` |
| `HUB_TRUSTED_PROXIES` | new | IPs or CIDRs of the reverse proxy in front of the Hub. Empty by default, which uses the socket's peer address. When set, the client is the rightmost `X-Forwarded-For` entry that is not a trusted proxy. |
| `RPC_URL`, `CHAIN_ID`, `RELAY_PUBLIC_URL`, `HUB_BUNDLER_URL` | removed | |

The client's address reaches `createApp` as a `clientAddress(c)` dependency. In production it is built on `getConnInfo` from `@hono/node-server/conninfo`; tests stub it, because `app.request` has no socket.

**Routes:**

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | — | `ok` |
| `GET /keys` | — | `{ ticket: { address, publicKey } }` |
| `POST /auth/verify` | — | A signed sign-in statement, returns `{ token, address, name, expiresAt }` |
| `PUT /me/name` | session | `{ name }`: 1–32 code points, trimmed, characters as in the statement grammar |
| `POST /map-servers` | signature | A signed Map server statement. The newest `Issued` per key is kept; rate-limited per network address. |
| `GET /map-servers?owner=` | session (that owner) | Map server keys that named this Character and serve no Land yet |
| `POST /lands` | signature | A signed Delegation, returns `{ landId }`. Refused without a matching Map server statement (403), when the key serves another Land (409), or over the daily limit (429). |
| `GET /lands/:landId`, `GET /lands?owner=`, `?mapServerKey=`, `?domain=` | — | One registered, visible `LandInfo`, with or without a cell; 404 otherwise. The relay and the Map server use these. |
| `PUT /lands/:landId/domain` | session (owner) | `{ domain \| null }`. The domain is lowercased, its trailing dot removed and converted to ASCII (IDNA); ports and wildcards are refused. Requires the DNS TXT record `_linked-realms.<domain>` = `land=<landId>`. |
| `GET /directory` | — | Lands with a cell; `Cache-Control: public, s-maxage=5, stale-while-revalidate=30` |
| `POST /tickets` | session | `{ landId, from? }` returns a signed ticket. The Land must have a cell, be visible and be online; `from` must be an adjacent cell and sets the arrival Gate. |
| `GET /tls/allowed?domain=` | — | 200 only for a verified own domain of a visible Land with a cell (Caddy's on-demand TLS `ask`) |
| `POST /reports`, `GET /admin/reports`, `POST /admin/lands/:landId/hidden` | as now | Unchanged apart from the address format |

These go away:
- the routes `/auth/nonce`, `/auth/verify` (SIWE), `POST /lands/:landId/delegation`, `GET /directory/:landId` and `POST /aa`;
- with them `ChainReads`, `verifySiwe`, `verifyTypedData`, the bundler, `deploymentFor`, the sponsorship code and `viem`.

**Data.** Migrations are append-only (`db.ts`).
- `003` drops `sponsorship`, `004` drops the old `delegation`, and `005` empties `report`, whose Land ids belong to the chain's Lands. Wiping is acceptable: the data is testnet only, and no Hub was deployed outside development.
- New tables:
  - `map_server (key pk, owner, statement, public_key, signature, issued_at)`;
  - `land (id bigserial pk, owner unique, map_server_key unique, statement, public_key, signature, issued_at, cell int unique null, cell_lost_at, last_online_at, domain unique null, domain_checked_at, hidden, created_at, updated_at)`;
  - `character (address pk, name, updated_at)`;
  - `land_quota (network, day, count, pk(network, day))`. The network is an IPv4 address or an IPv6 /64.
- `x` and `y` come from `spiralCoordinates(cell)`. The Land id and the cell are separate now.

**Sweep.** `sweep(now)` is part of `Deps`; `main.ts` runs it every 15 seconds with `setInterval`, and tests call it directly.
1. Read `/online` from the relay and set `last_online_at` for the Lands that are online.
2. Give cells to online, visible Lands without one, inside a transaction guarded by the unique index on `cell`.
3. Free the cells of Lands where `now - last_online_at` is at least 30 days.
4. Recheck each own domain's TXT record once a day, and drop the domain if it fails.
5. Delete quota rows older than 2 days, and Map server statements that serve no Land after 7 days.

### `packages/relay`

**Config:** `PORT`, `HUB_URL`, `RELAY_HOST` (its own host name), `LAND_BASE_DOMAIN`, `SHELL_ORIGINS`, `MAX_CLIENTS_PER_LAND`, `MAX_HOSTS` and `PLAYER_MAX_FRAME` (16 KiB by default).
- `SHELL_ORIGINS` feeds `frame-ancestors`. Anyone can host a Shell, but Lands served by a relay load only in the Shells its operator lists. That is a deliberate limit, and the operator adds origins on request.

**Routing by `Host`:**
- `<landId>.<LAND_BASE_DOMAIN>` is that Land.
- `RELAY_HOST` serves only `/host/<landId>`, `/online`, `/stats` and `/health`, so a Land cannot shadow them.
- Any other host is looked up with `GET /lands?domain=`. Results, failures included, are cached for 30 seconds; unknown hosts get 404.
- Every path on a Land host is forwarded, and a WebSocket upgrade on any path becomes a Player stream. The `/land/<id>/` prefix and the Colyseus five-part path go away.

**Host link:**
- The hello carries `{ statement, publicKey, signature }`.
- The relay checks that the address derived from `publicKey` is the `mapServerKey` from `GET /lands/:landId`. That route also returns Lands without a cell. The relay rechecks every 30 seconds.
- The limit for unauthenticated frames is raised to fit a hello of about 5 KB.
- The state machine, timeouts, close codes, stream multiplexing, buffers, pings, counters and `/online` stay.

**HTTP to a Land:**
- Responses stream instead of arriving as one base64 JSON message: `http-response { id, status, headers }`, then binary data frames on stream `id`, then `http-end { id }`.
- A response is capped at 32 MiB, and a browser with more than 4 MiB of it buffered loses it. Request bodies stay at most 64 KiB.
- More headers are forwarded: on requests `if-none-match` and `if-modified-since`; on responses `etag`, `last-modified` and `content-encoding`.
- The forced `sandbox; default-src 'none'` is replaced by `Content-Security-Policy: frame-ancestors <SHELL_ORIGINS>`, added to every Land response. A Land may send a stricter CSP of its own.
- `nosniff` stays, and the relay sets no cookies.
- An offline Land's pages get a small HTML page instead of JSON.

**Agent** (`@linked-realms/relay/agent`): `connectHost({ relayUrl, landId, mapServerKey, localPort, log })` signs with `@linked-realms/core` and streams local responses in 64 KiB chunks.

**Removed or updated:** `viem` goes. The k6 script and `scripts/load-host.ts` switch to Land URLs and Map server keys. The tests are rewritten on the same harness.

### `packages/map-server` (reference Land kit)

**Config.** These settings are added or kept:
- `LAND_OWNER` (required);
- `HUB_URL`;
- `HUB_TICKET_SIGNER` (the address that a ticket's `publicKey` must hash to);
- `MAP_SERVER_KEY_FILE` (created with mode 0600 on first start);
- `RELAY_URL`, `HOST`, `PORT`;
- `LAND_UI_DIR` (the built `client`, by default the copy in the image).

`RPC_URL`, `CHAIN_ID`, `MINING_*` and `LAND_ID` go away.

**Start:**
1. Load or create the Map server key, post the Map server statement, and print the key's address.
2. Wait until `GET /lands?mapServerKey=` returns a Land owned by `LAND_OWNER`. That gives the Land id.
3. Connect the relay agent.

**Server** (`ws` and `node:http`, replacing Colyseus):
- `GET /` and the Land UI's static files. Hashed `/assets/*` are `immutable`; `index.html` is `no-cache` with an `etag`.
- `WS /play`:
  - The first message must be `hello` within 10 seconds, checked as in `arrival.md`.
  - A 20 Hz tick sends `moved` for the Characters that moved; a new Character gets the full state in `welcome`.
  - Shuts down on SIGINT and SIGTERM.
- **Rules carried over:**
  - single-use nonces;
  - one session per address;
  - 30 messages per second;
  - the shared `step()` movement;
  - at most 64 Characters;
  - the owner flag, now from the Hub's `owner`.
- Visitors who declare an AI get a marker.

**Removed:**
- `chain.ts`, `miningKey.ts`, the Miner, `@linked-realms/miner`, `viem` and every `@colyseus/*` package;
- the scripts `e2e.ts`, `mining-e2e.ts`, `seed-world.ts` and `world-e2e.ts`, with their `package.json` entries. The new end-to-end test arrives in item 9.

**Tests:** `LandRoom.test.ts` becomes `land.test.ts` on raw WebSockets.
- It ports every existing case except mining.
- New cases: a missing or wrong arrival signature, a public key that does not match the ticket, a wrong `Land` or nonce in the arrival, a ticket issued before the start, a Land owned by someone other than `LAND_OWNER`, and the AI flag.

### `packages/client` (reference Land UI, inside the Shell's frame)

- **Deleted:**
  - `wallet.ts`, `passkey.*`, `character.ts`, `gold.*`, `mining.*` and `hub.ts`;
  - the panels for the wallet, Character, Gold, mining, backup and registration;
  - `ox`, `viem`, `@colyseus/sdk`, `VITE_RPC_URL`, `VITE_CHAIN_ID` and `VITE_HUB_URL`. The Land UI no longer talks to the Hub.
- **New `shell.ts`:**
  - It accepts the Shell's port, receives `init`, sends `travel` when `createGateEdge` fires, and shows `travelRefused`.
  - Opened outside a frame, the page says "Open this Land from the Shell".
- **New `connection.ts`:** a WebSocket to `/play` on its own origin, with protobuf. It sends `hello` with the handoff.
- **`scene.ts`** takes `{ send, onMessage, selfId }` instead of a Colyseus `Room`.
- **`index.html`** keeps only `#game` and the HUD.

### `packages/shell` (new)

**Stack:** a static Vite + TypeScript page (no framework, like `client`), `@linked-realms/core`, and `hash-wasm` 4.12.0 for Argon2id.

**Key store** (IndexedDB in the Shell's origin):
- Record: `{ version, address, kdf: { alg: "argon2id", m: 65536, t: 3, p: 1, salt }, iv, ciphertext }`.
- Encryption is AES-GCM through WebCrypto, with a fresh IV each time and the address as additional data.
- The parameters live in the record, so they can be raised later.

**Lock:**
- The Shell locks after 15 minutes without input on its own page, or when the Player chooses Lock.
- Input inside a Land's frame never reaches the Shell, so a Player who only plays is asked for the password at the next travel or signature. The Land keeps running while the Shell is locked.
- Locking wipes the key and the decrypted bytes (WASM memory and `Uint8Array`s) and drops the session token.
- Limit: the password string and the browser's own copies cannot be wiped from JavaScript.

**Pages:**
- **`setup.html`:** create a Character (confirm three words, set a password) or restore one from 24 words. It is the only page that asks for the words, and it never loads a Land.
- **`index.html`:** unlock, the Character (address and editable name), the Directory with "Enter", "Your Land", the Land frame, Report and Lock.
  - "Your Land" shows the Character's address for `LAND_OWNER`, the waiting Map servers, the Delegation and the Land's status, and the optional own domain.
  - The password field appears only in the Shell's own unlock form or modal.

**Frame:**
- `<iframe sandbox="allow-scripts allow-same-origin allow-pointer-lock" allow="" referrerpolicy="no-referrer">`.
- It sits in a fixed area under the Shell's bar and never covers it. The bar always shows the Land's name, its origin from the Directory and the line "The Shell never asks for your 24 words outside Setup."
- The `src` comes only from the Directory's `url`, and the port handler checks message shapes and sizes.

**Signing prompt:**
- A full-screen modal in the Shell's document. While it is open, the frame is `inert` with `pointer-events: none`.
- The Shell-built lines (Land, origin, Character) sit above a separate, labelled, scrollable box holding the Land's text. In that box, control, bidi and invisible characters are shown as escapes.
- "Approve" is not focused. It accepts only a pointer click, and only one second after the modal opens. "Deny" or closing returns `denied`.

**Headers** (set by Caddy, which serves the Shell):
- `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' <HUB_URL>; frame-src https: <dev: http://*.localhost:*>; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`.
- `frame-src` is broad, because own domains are not known in advance. What limits frames is the rule that `src` comes only from the Directory.
- `Cross-Origin-Opener-Policy: same-origin`.

**Tests:**
- Vitest, with `include: ["src/**/*.test.ts"]`: the key store round trip, a wrong password, the lock wiping the key, the port handler's checks, statement building and the prompt's escaping.
- Playwright lives in `e2e/` with its own `playwright.config.ts` and the script `test:browser`, so `pnpm test` never starts a browser.

### Deleting the EVM design

**Item 3** deletes `packages/indexer`, which nothing imports. It also removes:
- its line in `.dockerignore`;
- its mentions in the `Dockerfile` comment, in `README.md` and in the comment in `shared/src/format.ts`.

**Item 8** deletes the rest once its last user is rewritten:
- `packages/miner`;
- `contracts/`, its entries in `pnpm-workspace.yaml`, `eslint.config.js`, `.gitignore` and `.dockerignore`, and the CI `contracts` job (Foundry, the ABI diff and Slither);
- the compose services `anvil`, `deploy` and `seed`, and `ANVIL_PORT`;
- `docs/runbooks/base-sepolia.md`;
- `msgpackr-extract` from `allowBuilds`.

Plans and research from earlier phases are history and stay as they are.

### Containers, CI and documents

**`Dockerfile`:**
- A `wasm` stage (a pinned `rust` image with `wasm-bindgen-cli` 0.2.129) copies `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` and `crates/`, and builds `packages/core/pkg`.
- A `build` stage runs a full `pnpm install` and `vite build` for `client` and `shell`.
- The runtime stage keeps today's `--prod` install for the Hub, the relay and the Map server, and copies `pkg/` and `client/dist` in.
- A `shell` target puts `shell/dist` into a pinned `caddy` `-alpine` image with the headers above.
- `.dockerignore` stops excluding `packages/client` and gains `target/`.

**`compose.yaml`:**
- `postgres` stays the default service.
- The `world` profile runs `hub-api`, `relay`, `shell`, `map-1` and `map-2`, each Map server with its own key volume and `LAND_OWNER`.
  - The relay is published on `127.0.0.1` and `[::1]`, because macOS resolves `*.localhost` to `::1`.
  - Development keys (the Hub's ticket key, the admin, the two test Characters) are labelled as such and live only in `compose.yaml` and the e2e test.

**`deploy/`** (the production example used by the runbook):
- `Caddyfile` and `compose.public.yaml`.
- `*.<LAND_BASE_DOMAIN>` uses one wildcard certificate through DNS-01, which needs a Caddy build with the owner's DNS provider module.
- On-demand TLS, with `ask` to `/tls/allowed`, covers only verified own domains.
- Caddy's address is set in `HUB_TRUSTED_PROXIES`.
- The runbook asks for the Lands' base domain to be a different registrable domain from the Shell and the Hub, and listed on the Public Suffix List. Until it is listed, Lands can set cookies for one another, which is a known limit.

**CI:**
- **`rust` job** (from item 2): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- **`typescript` job** (from item 2): installs Rust and `wasm-bindgen-cli` and builds `packages/core` before typecheck and test.
- **`buf` job:** from item 4.
- **`browser` job** (from item 7): `playwright install --with-deps chromium firefox`, then `pnpm --filter @linked-realms/shell test:browser`.
- **`image` job:** builds both targets.

**Documents:**
- `README.md`, `CONTRIBUTING.md` and the package READMEs.
- `docs/self-hosting.md`, rewritten for `LAND_OWNER`, the Map server key, registering from the Shell and the cell sweep.
- A new `docs/runbooks/public-world.md` covering the domains, DNS, the server, Caddy, the Hub's keys and the admin.
- `CLAUDE.md` and `AGENTS.md`: drop Foundry and Slither, and add the WASM build.
- PLAN.md: section 4 drops "Colyseus 0.18 until step 2B"; section 8 drops "`forge test` and Slither until step 2B"; section 12 and the Log are updated.

## Order of work

Each item is one commit. After every commit:
- `pnpm install` has updated `pnpm-lock.yaml` where needed;
- `pnpm format:check`, `lint`, `typecheck` and `test` pass, and `cargo` checks pass once item 2 exists;
- CI is green.

The compose world and the end-to-end test stay broken from item 5 until item 9.

1. Protocol specs in `docs/protocols/` and ADR 0009. CONTEXT.md gains Land UI and Cell.
2. The Cargo workspace, `crates/core`, `packages/core`, the toolchain file, the ignores, the Turbo `build` task, and the CI `rust` job plus the Rust steps in the `typescript` job.
3. Delete `packages/indexer` and its references.
4. `shared`: `identity.ts`, the new `hub.ts` names next to the old ones, the `.proto`, generated code and the CI `buf` job.
5. `hub-api` rewritten.
6. `relay`, `map-server` and `client` together, because the agent's options, the Land URLs and the game protocol change on both sides. The old scripts in `map-server` are deleted here.
7. `packages/shell` and the CI `browser` job. The old Directory and EIP-712 names in `shared/src/hub.ts` are removed now that nothing uses them.
8. Delete `miner`, the chain parts of `shared` and `contracts/`, along with their CI and compose entries. Remove `viem` and Colyseus from the workspace.
9. The Dockerfile, compose, `deploy/`, the end-to-end test, the documents, and PLAN.md's progress section and Log.
10. Own domains for Land owners: the domain route, its daily recheck, the relay lookup and the TLS `ask`. This item is last because the Done-when check does not need it, but it stays in 2B (PLAN.md section 6).

## Verification

1. **Rust:** `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Covers the NIST vectors, the `ml-dsa` cross-check, the BIP-39 vectors, our identity vectors and the grammar's rejection cases.
2. **TypeScript:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
   - Statements are checked against the Rust vectors.
   - The Hub rules from PLAN.md section 8 run on PGlite:
     - one Land per Character, and no duplicate cells;
     - a cell only for a running Map server;
     - at most 3 new Lands per network address per day, including when `X-Forwarded-For` is spoofed;
     - a Land offline for 30 days loses its cell and returns at the edge.
   - Hub flows:
     - registration is refused without the Map server's statement, which stops one Character claiming another Character's Map server;
     - a sign-in cannot be replayed and is refused when its time is off;
     - names, tickets, adjacency and admin actions.
   - Relay:
     - routing by `Host`, with operator routes only on `RELAY_HOST`;
     - a Land without a cell can link;
     - the ML-DSA hello, a streamed response larger than 512 KiB, and the `frame-ancestors` header.
   - The Map server's arrival checks and the Shell's unit tests.
3. **Playwright** (`packages/shell`, Chromium and Firefox): the "a test shows" half of Done-when. The Hub is stubbed, and a hostile test Land is served on `1.localhost`. The tests check that:
   - the frame cannot read `parent.document`, the Shell's IndexedDB or the session token;
   - `signMessage` returns nothing until Approve is clicked, and Deny returns `denied`;
   - Enter or Space does not approve;
   - the prompt's header comes from the Shell, and the Land's text is boxed and escaped;
   - clicks on the frame do nothing while the prompt is open;
   - the frame never covers the bar;
   - messages from other windows or origins are ignored;
   - `pay` is refused;
   - `travel` and `signMessage` are rate-limited.
4. **`pnpm e2e:world`** against `docker compose --profile world up -d`:
   1. A headless browser creates two Characters in the Shell.
   2. Each Character registers the Map server (`map-1` or `map-2`) that named it.
   3. Both Lands get adjacent cells.
   4. One Character enters Land 1, walks east through the Gate into Land 2, and arrives at the west Gate.
   5. `docker compose stop map-1` shows Land 1 as offline, and starting it again brings it back.
5. **Manual check** in Chrome, Firefox and Safari: create a Character, register a Land, walk through a Gate.
6. **Two people on two machines** run Lands against a public Hub, relay and Shell set up with `docs/runbooks/public-world.md`. This is the other half of Done-when and needs the owner (question 6).

## Defaults chosen in this plan (say if you disagree)

- **Land ids and URLs:** Land ids are sequential numbers from the Hub, and the subdomain is `<landId>.<LAND_BASE_DOMAIN>`. Names cannot be used, because they are not unique.
- **One scheme everywhere:** the Hub's ticket key and Map server keys are ML-DSA-44 too.
- **Arrival:**
  - The AI field is in the Character's arrival statement, not the Hub's ticket.
  - The arrival challenge is the ticket nonce.
  - A Map server refuses tickets issued before it started.
- **Pairing a Map server with its owner:** the Map server learns its owner from `LAND_OWNER` and proves its key to the Hub. The Land owner pastes nothing into the Shell.
- **The daily limit:** "3 new Lands per network address per day" counts the network address of the request that creates the Land, which is the Player's browser. IPv6 is counted per /64. Replacing a Map server key does not count.
- **Cells:** "The edge" means one past the highest cell index in use, and a new Land takes the lowest free index.
- **Online status** is the relay's live list, cached for 2 seconds.
- **Data and maps:**
  - The Hub's development data is wiped by migrations.
  - `maps/empty-land.json` becomes hand-maintained.
  - `MINE_TILES` stays as map data, with no mining messages until 2C.
- **Serving the Land UI:** the Map server serves it through the relay. There is no relay-side cache; the browser caches hashed assets.
- **Shell:**
  - No Worker for unlocking or signing; unlocking may pause the page for about a second.
  - The idle timer counts only input on the Shell's own page.
  - Lands load only in the Shells listed in a relay's `SHELL_ORIGINS`.
- **Delivery:** one branch, one commit per item above. Nothing is pushed or opened as a PR until the owner asks.

## Questions for the project owner (answered 2026-10-29: the recommended option in each)

1. **Where TypeScript checks signatures and derives addresses.**
   - (A, recommended) `hub-api`, `relay` and `map-server` use the WASM build of `crates/core`, like the Shell. That gives one implementation of addresses and signatures, as P9 asks. The cost: Rust and `wasm-bindgen-cli` are needed to run any TypeScript test and to build the image; 2C needs Rust in the image anyway.
   - (B) The Node packages use Node 26's built-in `node:crypto`, which has ML-DSA-44 and keccak-256 (checked on Node 26.13.0). Only the Shell uses WASM. The TypeScript side then needs no Rust, but there is a second copy of the address encoding, kept honest only by the shared vectors. This is an exception to P9, so it needs your explicit approval.
2. **Address format.**
   - (Recommended) Bech32m `tlr1…` over the version, the scheme and the full 32-byte keccak256: about 65 characters.
   - Alternative: a 20-byte hash, about 46 characters. Shorter, but with less quantum preimage margin.
   - Either way the format is permanent once 2C puts it on chain.
3. **Deriving the key from the 24 words.**
   - (Recommended) BIP-39 seed with an empty passphrase, then HKDF-SHA512 with the labels above.
   - This is our own profile, because no standard exists. It is frozen by vectors in ADR 0009.
4. **The password KDF in the Shell.**
   - (Recommended) Argon2id through `hash-wasm` (MIT, about 11 kB, already used by `packages/miner`). It resists GPUs better.
   - Alternative: PBKDF2-SHA256 with 600,000 iterations through WebCrypto. It needs no dependency but is weaker.
5. **New libraries and tools.** Approving this plan would approve:
   - Rust crates: `fips204`, `bip39`, `hkdf`, `sha2`, `sha3`, `bech32`, `wasm-bindgen`, and `ml-dsa` for tests.
   - `wasm-bindgen-cli`.
   - `@bufbuild/protobuf`, plus `@bufbuild/buf` and `@bufbuild/protoc-gen-es` for development.
   - `hash-wasm`.
   - `@playwright/test`, with the Chromium and Firefox downloads in CI. This is large, but the isolation half of Done-when can only be proven in a real browser.
   - Pinned `rust` and `caddy` images.
   - Without Playwright, the isolation test becomes a manual checklist.
6. **Rust on this Mac and the public world.**
   - May I install `rustup` with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` 0.2.129? That adds about 1.5 GB in `~/.rustup` and `~/.cargo`. None of them is installed now.
   - The two-machine check needs a public Hub, relay and Shell over HTTPS, because WebCrypto requires a secure context.
     - (Recommended) I write `deploy/` and the runbook. You provide a server, two registrable domains (one for the Shell and Hub, one for Lands) and a DNS provider that Caddy supports for the wildcard certificate.
     - Alternatively, I deploy it on the carthings develop server with domains you point at it.
