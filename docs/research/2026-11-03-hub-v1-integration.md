# Research brief: joining Hub v1 through the connect-agent

**Basis.**

- Question: what must Linked Realms build so that a Player enters a Land through Hub v1 (`hub.linkedrealms.com`), using only the connect-agent's loopback contract and importing no Hub code (ADR 0017)?
- Sources: the Hub's private repository `carthings-vn/linked-realms-hub` at commit `bbe5f0f` (paths below prefixed `hub:`), and this repository at `a2f5225`. Every Hub claim here was checked against its source by a second reader; line numbers are at those commits.
- The project owner chose to publish it here on 2026-11-03, and answered decisions 1–3 in section 4 the same day.

## Summary

- **The implemented contract is small.** The Land agent dials the game at `ws://127.0.0.1:<port>/connect` with a bearer token and sends one JSON prelude naming the Player; every later frame is game traffic (`hub:protocol/agent-endpoint-profile.md:37-74`). The agent does everything else: Hub tunnel, signed card, admission, Noise, bans and policy (`hub:protocol/agent-endpoint-profile.md:11-14`). The Node channel, Colyseus bridge and admin API in `hub:protocol/agent-local-api.md` are not implemented and are not required (`hub:protocol/agent-endpoint-profile.md:73-74`).
- **Blocker: the game's client has no way onto the Player's machine.** The Player agent serves the page a Player plays in from its own origin, `http://127.0.0.1:<port>/`. The CLI hard-codes that page to the Hub's demo (`hub:cmd/connect-agent/main.go:195`), which serves only `/`, `/app.js` and `/app.css` (`hub:tools/reference-game/server/client.go:18`), under a CSP of `default-src 'none'; … img-src data:` (`client.go:13`). Phaser's bundle, textures and audio cannot load there, and a page on any other origin is outside the contract (`hub:protocol/agent-endpoint-profile.md:67-68`). Only the Hub's author can open this.
- **Identity changes.** The agent identifies a Player by an Ed25519 key per install (`player_key`), not by the game's ML-DSA-44 Character. The agent always sends an empty wallet in GREETING (`hub:internal/agent/entry_player.go:127`) and the prelude has no wallet field, so no LR address reaches the game.
- **Travel between Lands is not usable.** The wire has `source_land` and `arrival_gate`, but the agent always sends `nil` and `0` (`entry_player.go:127`), the prelude does not carry them, and a Player agent holds one session across all Lands (`hub:protocol/agent-local-api.md:36`).

## 1. The Land side: what the Map server must do

From `hub:protocol/agent-endpoint-profile.md:37-74` and the reference server `hub:tools/reference-game/server/server.go`:

1. Listen on `127.0.0.1:<port>` and upgrade only `/connect`. Reject another `Host`, any `Origin`, and a missing or wrong `Authorization: Bearer <token>`, compared in constant time.
2. The token is 32 random bytes, unpadded base64url, in an owner-only file given to both the game and the agent; rotate it when the pair restarts (`hub:tools/reference-game/main.go:16-24`, `server.go:140-143`). The agent sends it to whatever listens on the port, so the game must be the only listener.
3. The first frame is a text frame of at most 16 KiB: `{"v":1,"session_id":"<32 hex>","player_key":"<64 hex>","display_name":"<1–32 UTF-8 bytes>","signed_profile":"<unpadded base64url>"}`. All five fields are required; reject unknown, duplicate or null fields, trailing JSON and any other `v`. The reference server allows 5 s for it.
4. Bind that identity to the socket. Client payloads never supply identity. Later frames keep their text/binary type and boundaries.
5. Player-to-Land messages are at most 16 KiB and Land-to-Player at most 1 MiB (`hub:protocol/v1.md:142`). A closed socket ends the session; a reconnect is a fresh entry. There is no end-to-end flow control: a slow Player is dropped (`hub:docs/connect-agent.md:192-193`).
6. A Land shows at most 64 Players and 80 sessions (`hub:protocol/agent-local-api.md:189`). The agent counts `current_players` from open game sockets.
7. The game listens before `connect-agent land --game 127.0.0.1:PORT --game-token-file PATH` starts (`hub:docs/connect-agent.md:152-158`). The Land agent runs on Windows only today (`hub:docs/connect-agent.md:35`); in Docker, the container's `127.0.0.1` is not the agent's.

## 2. The Player side: what the page must do

- Read `GET /api/status` with the capability from the URL fragment as `Authorization: Bearer <cap>`; phases `need_name`, `finding`, `ready`, `playing`, `ended`, `error` (`offline`, `denied`, `full`, `timeout`, `not_found`, `rate_limited`, `internal`). `POST /api/profile` sets the name; `POST /api/retry` starts again (`hub:docs/connect-agent.md:92-148`).
- At `ready`, open one WebSocket to `ws://127.0.0.1:<port>/bridge/<handle>`; the handle is single-use and expires with the seat (`hub:protocol/agent-endpoint-profile.md:63-69`).
- The page may call only its own origin, so it cannot read an LR Node or open the old Shell. The Hub's public list is `GET /lands.json` → `{"lands":[{key, name, description, players, max_players}]}` with `key` in base64url (`hub:internal/hub/site.go:24-30`).

## 3. Gaps in this repository

| Part | Change |
|---|---|
| `map-server` | Add the `/connect` handler, token file, Host/Origin checks and prelude parser in place of `verifyHandoff` on `/play` (`land.ts:209`); lower the inbound frame limit from 32 KiB to 16 KiB (`land.ts:45-54`). Remove Hub registration (`hub.ts`), the relay link (`main.ts:2`, `config.ts:4`) and the Hub settings in `config.ts`. `mapServerKey.ts` goes, but `config.ts:128` derives the `lr-node` data folder from its path, so the Node's data needs a new home. |
| `shared` | `land.proto` loses `Hello{handoff}` and the Gate messages, and `buf` regenerates `src/gen`. The ticket, arrival, Map server and relay statements go (`identity.ts`, `hub.ts`). `NAME_MAX_CODE_POINTS = 32` counts code points; the prelude allows 32 bytes. |
| `client` | `playUrl` (`connection.ts:30-33`) becomes `/bridge/<handle>` and `encodeHello` drops the handoff. The Shell bridge (`client/src/shell.ts`: `pay`, `signMessage`, the Mine switch) has no parent page. |
| `shell` | Its Hub parts (`hub.ts`, `account.ts`, `handoff.ts`, `travel.ts`) are dead. Its vault and Gold sending are LR's web wallet now, at `https://wallet.linkedrealms.com`. `e2e-chain` lives here and goes with it; LR's wallet has its own. |
| `hub-api`, `relay` | Removed: Hub v1 replaced them (ADR 0017). Their quotas, hiding and reports have no Hub v1 home. |
| `dashboard` | Keep the Node half; the directory half can read `/lands.json`. |
| Mine | `LAND_OWNER` exists (`config.ts:154`). The Mine switch is a signed ML-DSA request from the owner's Character, checked against the Hub's `land.owner` (ADR 0014, `shared/src/mine-switch.ts`); with `hub-api` gone nothing checks it, so the switch needs a new rule. |
| Tests and CI | `e2e-world` is built on `hub-stub`, `hub-api` and relay. CI's `browser`, `buf` and `image` jobs and `image.yml` change with the Shell, `land.proto` and the Land image. |
| Docs | ADR 0004, 0009 and the Hub/Shell parts of 0008 and 0010 are superseded; 0014 is amended; 0007 stays; 0005 and 0006 need a word. `PLAN.md` sections 3.1, 3.3, 3.4, `CONTEXT.md` (Hub, Shell, Delegation, Travel ticket) and the protocols for the Map server, arrival, Gates and the Shell's Land UI change. |

## 4. Decisions for the project owner

The project owner's answers of 2026-11-03: decision 1, ask the Hub's author (the questions in section 5 went to them); decision 2, `player_key` is the in-world identity with an LR address binding later; decision 3, retire the Shell. Decisions 4–7 are open. An ADR records them once the Hub's author answers.

1. **Client delivery** (blocks everything else). Ask the Hub's author to let the Player agent serve a game-supplied build under a CSP that allows its assets (recommended); or write a native client that opens `/bridge/<handle>` itself (the handle suffices for native clients); embedding Phaser in each agent release was rejected by the Hub's plan (`hub:docs/hub-connect-agent-plan.md:101`).
2. **Identity.** Recommended: `player_key` is the in-world identity; a later, optional signed binding links it to an LR address for Gold. The alternative, dropping ML-DSA Characters entirely, strands the existing Characters and their test Gold.
3. **The Shell.** Recommended: retire it; play happens on the agent's page and Gold in LR's wallet. Game principle P6 (Land code only in an isolated frame, prompts outside it) cannot hold on the agent's page and needs the owner's edit.
4. **Mine switch.** Recommended: the operator starts the Mine locally where the Map server runs, off by default and visible, until a binding from decision 2 exists.
5. **Rewards.** The Hub's reserved C2–C5 (wallet balance and sends, mining, `reward_transfer`) would have the agent spend from a wallet derived from its root seed, under daily caps (`hub:protocol/agent-local-api.md:115-119`). Recommended: reject; Players send Gold with LR's wallet, which shows each transaction in its own prompt.
6. **Gates and travel.** Recommended: removed until the agent carries `source_land` and `arrival_gate`.
7. **Tests.** Recommended: CI uses a fake agent in this repository (token, Host, prelude, bridge, `/api/status`); live checks run on Windows against an agent build pinned by checksum.

## 5. Questions for the Hub's author

1. Can the Player agent serve a game's own build (several files, images, audio, WebAssembly) and with what CSP?
2. Which document is authoritative for the bridge: `hub:protocol/agent-local-api.md:9` and `hub:docs/hub-connect-agent-plan.md:65` (token and handle) or `hub:protocol/agent-endpoint-profile.md:66-67` (handle alone)? What changes the prelude's `v`, and is there a release manifest to pin an agent build?
3. Will GREETING ever carry wallet bytes, or the prelude carry `source_land` and `arrival_gate`?
4. How should the Land agent reach a game in a container?
5. Is one session per Player agent a hard limit?
6. When do macOS and Linux builds come?

## 6. Order of work

| Step | Done when |
|---|---|
| M0: decisions 1–7, questions answered, an ADR | The ADR is merged |
| M1: one Land, one Player, no Gold, no Gates | A fake-agent test passes in CI for good and bad preludes; on Windows with the real agent, a Land is listed on `hub.linkedrealms.com`, a Player enters, and both see each other move |
| M2: remove `hub-api`, relay, the Shell and their tests; rewire the dashboard | Nothing imports them; `compose.yaml` starts a seed and a Map server |
| M3: the Mine switch under decision 4 | The Mine starts only on the operator's action, off by default |
| M4: optional LR address binding and Gold sends through LR's wallet | A Player's binding links `player_key` to an address; sends show the wallet's prompt |

M1 takes one to three weeks if decision 1 gives the game a way to serve its build, and four to six if the client goes native.
