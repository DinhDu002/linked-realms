# @linked-realms/relay

The relay: a Node.js + `ws` process that lets Players reach Map servers that have no open port
(PLAN.md section 3.5, ADR 0004). A Map server dials the relay once; Player HTTP matchmaking and
WebSockets for its Land are carried over that link as numbered streams. The relay decides
nothing about the game: it only forwards, authenticates links, and counts.

Also exports the **agent** (`@linked-realms/relay/agent`), which the Map server runs to dial the relay.

## Run

```bash
HUB_URL=http://localhost:8787 pnpm --filter @linked-realms/relay start
```

| Variable               | Default  | Meaning                                                        |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `HUB_URL`              | required | hub-api base URL; Delegations are read from `/directory/<id>`  |
| `PORT`                 | `8080`   | Listen port                                                    |
| `MAX_CLIENTS_PER_LAND` | `64`     | Player WebSockets per Land; more are refused with 503          |
| `MAX_HOSTS`            | `1000`   | Host links; more are refused with 503                          |

## Endpoints

| Path                                     | Purpose                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `WS /host/<landId>`                      | Map server link (challenge, signed hello, ready)                           |
| `* /land/<landId>/...`                   | HTTP forwarded to the Land with the prefix stripped (503 JSON if offline)  |
| `WS /land/<landId>/<processId>/<roomId>` | Player WebSocket (what the Colyseus SDK builds from `relayLandUrl`)        |
| `GET /online`                            | `{ "lands": [1, 2] }`, sorted                                              |
| `GET /stats`                             | Bytes and messages per Land and per session (`In` = Player to Land)        |
| `GET /health`                            | `ok`                                                                       |

`/stats` and `/online` are for operators and hub-api: do not expose them on the public listener.

## Rules the relay enforces

- **Host auth.** The Map server signs (EIP-191, Mining key) `linked-realms relay: host Land <id>\nNonce: <nonce>`.
  The relay accepts it only if the signer equals the `miningKey` in `GET <HUB_URL>/directory/<id>`.
  Close codes: 4401 bad signature, 4403 not the delegated key, 4404 Land not in the Directory
  (unknown or hidden), 4408 no hello in 10 s, 4409 replaced by a newer link, 1013 Hub unreachable or relay full.
- **Live checks.** Every 30 s each connected host's Delegation is read again; a changed Mining key or
  a hidden Land drops the link (4403). A Hub outage keeps links up. Pings every 15 s; two unanswered pings close the link.
- **Players** connect only to a Land with a live host. Frames from a Player are capped at 16 KiB,
  compression is off on every socket, and a Player whose send buffer passes 1 MiB is closed (1013).
  Closing either side closes the other.
- **HTTP** forwards the method, path, query, and only these request headers: `content-type`, `accept`,
  `authorization`, `origin`, `access-control-request-*`. Body limit 64 KiB (413), timeout 30 s (504).
  The Map server's status, headers (CORS included) and body come back; `Set-Cookie` and connection-level headers do not.

## Host link protocol (`src/protocol.ts`)

JSON text frames: `challenge`, `hello`, `ready`, `http` / `http-response` (body in base64), `open`
(stream id, path), `close` (stream id, code). Binary frames: 4-byte big-endian stream id, 1 byte
(0 = binary, 1 = text), payload. Every control message is validated on receipt.

## Agent

```ts
import { connectHost } from "@linked-realms/relay/agent";

const link = connectHost({ relayUrl, landId, privateKey: miningKey, localPort, log: console.log });
await link.close();
```

It answers the challenge, opens a local WebSocket to `ws://127.0.0.1:<localPort><path>` for every
`open`, runs `http` requests against `http://127.0.0.1:<localPort>`, and reconnects with backoff
(1 s doubling to 30 s) until closed. It drops a link that hears nothing from the relay for 45 s.

## Load test (PLAN.md section 3.5 rule 8)

`load/land.js` is a k6 script (`grafana/k6:2.3.0`, Go). Each virtual user is one Player WebSocket to
`/land/<LAND>/load/room` that sends a 100-byte message every 50 ms (20/s); the host echoes it back
(round-trip latency) and broadcasts 100 bytes to every Player at 20 Hz, so each Player also receives
about 20 messages per second. `scripts/load-host.ts` is the stub host: a stub Hub, a plain `ws`
echo and broadcast server, and the real agent linking it to the relay as the Land. No Colyseus.

```bash
# 1. stub host (stub Hub on :8799; it keeps retrying until the relay is up)
HUB_PORT=8799 RELAY_URL=http://127.0.0.1:8081 LAND_ID=1 pnpm --filter @linked-realms/relay load-host
# 2. relay against the stub Hub, with room for 1,000 Players on the Land
HUB_URL=http://127.0.0.1:8799 PORT=8081 MAX_CLIENTS_PER_LAND=1000 pnpm --filter @linked-realms/relay start
# 3. k6, reaching the relay from the container
cd packages/relay && docker run --rm -v "$PWD/load:/load:ro" grafana/k6:2.3.0 run \
  -e RELAY_WS=ws://host.docker.internal:8081 -e LAND=1 -e VUS=200 -e SECONDS=30 -e RAMP_SECONDS=10 /load/land.js
```

Players join spread over `RAMP_SECONDS`: a burst of 200 connects at once overflowed the listen
backlog of the local stub on macOS (somaxconn 128; 61 to 68 connections reset) and said nothing about the relay.

### Baseline (2026-10-29)

Apple M5 (10 cores), macOS 27.0.1, Docker 29.8.2, Node.js 26; relay, stub host and k6 on the same machine
(k6 in Docker Desktop's VM), so the numbers include everything sharing those cores.

| Run                                                  | Result            |
| ---------------------------------------------------- | ----------------- |
| Players (VUs), 30 s each after a 10 s ramp           | 200, all connected, 0 WebSocket errors |
| Messages Players -> Land (echoed)                    | 116,250 sent, 116,103 echoed, about 2,900/s |
| Messages Land -> Players (broadcast + echo)          | about 5,800/s received by k6 |
| Round-trip latency (Player -> relay -> agent -> stub -> back) | avg 40 ms, median 8 ms, p90 151 ms, p95 202 ms, max 1.4 s |
| Data                                                 | 12 MB sent, 24 MB received (about 0.3 and 0.6 MB/s) |
| Relay process after the run                          | 0.7% CPU idle, 126 MB RSS |

The p95 is dominated by the stub host and k6 sharing the machine (the 20 Hz broadcast to 200 Players is
sent in one burst every 50 ms); the threshold in `land.js` is p95 < 500 ms. Treat this as the first
baseline to compare against, not a capacity limit: raise `VUS` to find the knee.
