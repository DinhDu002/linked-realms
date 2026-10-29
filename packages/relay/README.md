# @linked-realms/relay

The relay: a Node.js + `ws` process that lets Players reach Map servers that have no open port
(PLAN.md section 3.5, ADR 0004, ADR 0008). A Map server dials the relay once; Player HTTP requests and
WebSockets for its Land are carried over that link as numbered streams. The relay decides
nothing about the game: it only forwards, authenticates links, and counts. The link protocol is
`docs/protocols/map-server-hub-relay.md` (mandatory); this package is its reference implementation.

Also exports the **agent** (`@linked-realms/relay/agent`), which the Map server runs to dial the relay.

## Run

```bash
HUB_URL=http://localhost:8787 pnpm --filter @linked-realms/relay start
```

| Variable               | Default          | Meaning                                                                                       |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `HUB_URL`              | required         | hub-api base URL; Lands are read from `/lands/<id>`                                           |
| `PORT`                 | `8080`           | Listen port                                                                                   |
| `RELAY_HOST`           | `localhost:8080` | This relay's host as Map servers dial it. A hello must name it (not the request's `Host`)     |
| `LAND_BASE_DOMAIN`     | `localhost:8080` | A Land is served at `<landId>.<LAND_BASE_DOMAIN>`                                             |
| `SHELL_ORIGINS`        | empty            | Comma-separated origins (`https://shell.example`) allowed to frame a Land; empty allows none  |
| `MAX_CLIENTS_PER_LAND` | `64`             | Player WebSockets per Land; more are refused with 503                                         |
| `MAX_HOSTS`            | `1000`           | Host links; more are refused with 503                                                         |
| `PLAYER_MAX_FRAME`     | `16384`          | Largest frame a Player may send, in bytes                                                     |

Both hosts must be lowercase host names with an optional port; `SHELL_ORIGINS` entries must be
`http(s)` origins without a path. Bad values stop the start with a message naming the variable.

## Routing by `Host`

- `<landId>.<LAND_BASE_DOMAIN>` (any letter case; the id is decimal without leading zeros) is that Land.
  Every path is forwarded to its Map server, and a WebSocket upgrade on any path becomes a Player stream.
  A Land with no live link gets a short `503` HTML page that names nothing about it.
- Every other `Host` gets the relay's own routes, and nothing else (`404`):

| Path                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `WS /host/<landId>` | Map server link (challenge, signed hello, ready)                           |
| `GET /online`       | `{ "lands": [1, 2] }`, sorted (hub-api's sweep reads it)                   |
| `GET /stats`        | Bytes and messages per Land and per session (`In` = Player to Land)        |
| `GET /health`       | `ok`                                                                       |

`/stats` and `/online` are for operators and hub-api: do not expose them on the public listener.
Own domains for Land owners (`GET /lands?domain=` on the Hub) are not served yet (step 2B item 10).

## Rules the relay enforces

- **Every response on a Land host** (a Land's own, and the relay's 503, 404, 413, 504 pages) carries
  `Content-Security-Policy: frame-ancestors <SHELL_ORIGINS>` (`'none'` when empty) and
  `X-Content-Type-Options: nosniff`. A Land's own `content-security-policy` is added as a second header, so a
  Land can only tighten the policy. The relay never sets cookies, and `set-cookie` is never forwarded.
- **Host auth.** After the relay's `{ t: "challenge", nonce }`, the Map server sends
  `{ t: "hello", statement, publicKey, signature }`: a `relay-host` statement (`Relay`, `Land`, `Nonce`)
  signed with its Map server key. The relay accepts it only if `Relay` is `RELAY_HOST`, `Land` is the id in the path,
  `Nonce` is the challenge, and the address of `publicKey` is the `mapServerKey` of `GET <HUB_URL>/lands/<id>`.
  Before `ready` the relay accepts one hello of at most 16 KiB and nothing else.
  Close codes: 4401 any failed hello (bad signature, other relay, other Land, wrong nonce, not the Land's key, unknown or hidden Land,
  oversize or unexpected frame), 4403 recheck found the Land hidden, unknown or its key changed, 4408 no hello in 10 s,
  4409 replaced by a newer link, 1013 Hub unreachable or relay full.
- **Live checks.** Every 30 s each connected host's Land is read again (a 404 or another key drops the link with 4403).
  A Hub outage keeps links up. Pings every 15 s; two unanswered pings close the link.
- **Players** connect only to a Land with a live host. Frames from a Player are capped at `PLAYER_MAX_FRAME`,
  compression is off on every socket, and a Player whose send buffer passes 1 MiB is closed (1013).
  Closing either side closes the other.
- **HTTP** forwards the method, path, query, and only these request headers: `content-type`, `accept`,
  `accept-encoding`, `origin`, `if-none-match`, `if-modified-since`, `access-control-request-*`. Request body limit 64 KiB (413).
  The response streams: status and these headers (`content-type`, `content-encoding`, `cache-control`, `etag`, `last-modified`,
  `vary`, `retry-after`, `access-control-*`, `content-security-policy`), then the body as it arrives. No `http-response` in 30 s is a 504
  (the same limit applies between body chunks). A response is cut off past 32 MiB, or when its browser is more than 4 MiB behind,
  or when the Map server ends it with `aborted`. HTTP ids and stream ids come from one counter.

## Host link protocol (`src/protocol.ts`)

JSON text frames: `challenge`, `hello`, `ready`, `http` (body in base64), `http-response` (status and headers),
`http-end` (optional `aborted`), `open` (stream id, path), `close` (stream id, code). Binary frames: 4-byte
big-endian stream id, 1 byte (0 = binary, 1 = text), payload; for an HTTP id they carry the response body in
chunks of at most 64 KiB. Every control message is validated on receipt.

## Agent

```ts
import { Key } from "@linked-realms/core";
import { connectHost } from "@linked-realms/relay/agent";

const link = connectHost({ relayUrl: "wss://relay.example", landId, mapServerKey: key, localPort, log: console.log });
await link.close();
```

`relayUrl` is a `ws://` or `wss://` base URL without a path; the agent dials `<relayUrl>/host/<landId>`, and the
hello's `Relay` is `new URL(relayUrl).host`, so the relay's `RELAY_HOST` must be that host. It answers the challenge
with a `relay-host` statement signed by `mapServerKey` (a `Key` from `@linked-realms/core`), opens a local WebSocket to
`ws://127.0.0.1:<localPort><path>` for every `open`, runs `http` requests against `http://127.0.0.1:<localPort>` and
streams the response body in frames of at most 64 KiB (`http-end` with `aborted: true` if the local body fails), and
reconnects with backoff (1 s doubling to 30 s) until closed. It drops a link that hears nothing from the relay for 45 s.

## Load test (PLAN.md section 3.5 rule 8)

`load/land.js` is a k6 script (`grafana/k6:2.3.0`, Go). Each virtual user is one Player WebSocket to
`/play` on the Land's host (`<LAND>.<LAND_BASE_DOMAIN>`) that sends a 100-byte message every 50 ms (20/s); the host echoes it back
(round-trip latency) and broadcasts 100 bytes to every Player at 20 Hz, so each Player also receives
about 20 messages per second. `scripts/load-host.ts` is the stub host: a stub Hub, a plain `ws`
echo and broadcast server, and the real agent linking it to the relay as the Land. No Map server.

```bash
# 1. stub host (stub Hub on :8799; it keeps retrying until the relay is up)
HUB_PORT=8799 RELAY_URL=ws://127.0.0.1:8081 LAND_ID=1 pnpm --filter @linked-realms/relay load-host
# 2. relay against the stub Hub, with room for 1,000 Players on the Land
HUB_URL=http://127.0.0.1:8799 PORT=8081 RELAY_HOST=127.0.0.1:8081 LAND_BASE_DOMAIN=localhost:8081 MAX_CLIENTS_PER_LAND=1000 pnpm --filter @linked-realms/relay start
# 3. k6, reaching the relay from the container
cd packages/relay && docker run --rm -v "$PWD/load:/load:ro" grafana/k6:2.3.0 run \
  -e RELAY_WS=ws://host.docker.internal:8081 -e LAND=1 -e LAND_BASE_DOMAIN=localhost:8081 -e VUS=200 -e SECONDS=30 -e RAMP_SECONDS=10 /load/land.js
```

Players join spread over `RAMP_SECONDS`: a burst of 200 connects at once overflowed the listen
backlog of the local stub on macOS (somaxconn 128; 61 to 68 connections reset) and said nothing about the relay.

### Baseline (2026-10-29)

Apple M5 (10 cores), macOS 27.0.1, Docker 29.8.2, Node.js 26; relay, stub host and k6 on the same machine
(k6 in Docker Desktop's VM), so the numbers include everything sharing those cores.

| Run                                                           | Result                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Players (VUs), 30 s each after a 10 s ramp                    | 200, all connected, 0 WebSocket errors                    |
| Messages Players -> Land (echoed)                             | 116,250 sent, 116,103 echoed, about 2,900/s               |
| Messages Land -> Players (broadcast + echo)                   | about 5,800/s received by k6                              |
| Round-trip latency (Player -> relay -> agent -> stub -> back) | avg 40 ms, median 8 ms, p90 151 ms, p95 202 ms, max 1.4 s |
| Data                                                          | 12 MB sent, 24 MB received (about 0.3 and 0.6 MB/s)       |
| Relay process after the run                                   | 0.7% CPU idle, 126 MB RSS                                 |

The p95 is dominated by the stub host and k6 sharing the machine (the 20 Hz broadcast to 200 Players is
sent in one burst every 50 ms); the threshold in `land.js` is p95 < 500 ms. Treat this as the first
baseline to compare against, not a capacity limit: raise `VUS` to find the knee.
