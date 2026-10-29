# Map server ↔ Hub and relay

Status: mandatory (ADR 0008). A Map server, in any language, uses these to register, find its Land and serve it through the relay. Map server ↔ Node over JSON-RPC follows in step 2C. Signed statements are defined in `identity.md`.

## Registering with the Hub

1. **The owner's address.** The Land owner gives the Map server their Character's address (`LAND_OWNER` in the reference kit).
2. **The Map server statement.** The Map server creates its Map server key once and keeps it. It signs a `linked-realms Map server` statement:
   - `Hub` is the Hub's host;
   - `Owner` is the owner's address;
   - `Map server key` is its own address;
   - `Issued` is the current time.

   It posts the statement to the Hub, and posts a new one whenever `LAND_OWNER` changes.
3. **The Delegation.** In the Shell, the Land owner sees the Map server keys that named them and signs a `linked-realms Delegation` for one of them.
4. **The Land.** The Hub creates the Land only if the Map server statement and the Delegation name each other. Neither side can be claimed by a third party.

### Hub routes

**`POST /map-servers`**
- Body: `{ statement, publicKey, signature }` (a Map server statement).
- `204` on success.
- `400` if the body is malformed, the signature is bad, or `Issued` is more than 5 minutes off the Hub's clock.
- `409` if a newer statement from this key exists.
- `429` if one network address sends too many.

**`GET /keys`** returns `{ "ticket": { "address": "tlr1…", "publicKey": "<base64>" } }`, the Hub's ticket key (`arrival.md`).

**`GET /lands?mapServerKey=<address>`** and **`GET /lands/<landId>`** return a `LandInfo`, or `404` if the Land is unknown or hidden:

```json
{
  "landId": 7,
  "owner": "tlr1…",
  "ownerName": "Mai",
  "x": 1,
  "y": 0,
  "url": "https://7.lands.example",
  "mapServerKey": "tlr1…",
  "online": true
}
```

- `x` and `y` are `null` while the Land has no cell. A Land without a cell must still be able to go online, because it gets its cell only after it does.
- A Map server asks every 10 seconds until its Land exists. It serves the Land only if `owner` is its configured owner.

## The host link to the relay

- **Connecting.** The Map server opens one outbound WebSocket to `wss://<relay host>/host/<landId>` (`ws://` in development). The Land owner opens no port.
- **Frames.**
  - Control messages are JSON text frames with a field `t`.
  - Data frames are binary: a 4-byte big-endian stream id, 1 byte of kind (`0` binary, `1` text), then the payload.
  - A frame is at most 1 MiB.

### Authentication

1. The relay sends `{ "t": "challenge", "nonce": "<32 lowercase hex>" }`.
2. Within 10 seconds, the Map server answers `{ "t": "hello", "statement", "publicKey", "signature" }`. The hello is a `linked-realms relay host` statement:
   - `Relay` is the relay's host as the Map server dialled it;
   - `Land` is the Land id;
   - `Nonce` is the challenge's nonce.
3. The relay checks the signature, the statement and that the address of `publicKey` is the Land's `mapServerKey` (`GET /lands/<landId>`). Then it sends `{ "t": "ready" }`.
4. Otherwise it closes with code `4401`. Before `ready`, it accepts nothing else, and no frame over 16 KiB.

**Afterwards:**
- The relay rechecks the Land every 30 seconds and closes with `4403` once it is hidden or its key changed.
- A second link for the same Land replaces the first, and the first is closed with `4409`.
- The relay pings every 15 seconds. A link that misses two pings is closed. The Map server reconnects with backoff from 1 to 30 seconds.

### Player connections

**`{ "t": "open", "stream": n, "path": "/play?…" }`**
- A browser opened a WebSocket to the Land's URL.
- The Map server connects it to its own WebSocket server for `path`.
- Each message then travels as a data frame on stream `n`.

**`{ "t": "close", "stream": n, "code": c }`**
- Either side closed the stream.
- Close codes outside the ones RFC 6455 allows on the wire become 1011.

### HTTP requests

**Request** (relay to Map server):
- `{ "t": "http", "id": n, "method", "path", "headers", "body": "<base64>" }`
- Request bodies are at most 64 KiB.

**Response** (Map server to relay):
1. `{ "t": "http-response", "id": n, "status", "headers" }`.
2. The body as data frames on stream `n`, at most 64 KiB each.
3. `{ "t": "http-end", "id": n }`, or `{ "t": "http-end", "id": n, "aborted": true }` if the body failed partway.

**Limits:**
- A response may be up to 32 MiB.
- The relay answers `504` if no `http-response` arrives within 30 seconds.
- The relay drops a response whose browser falls more than 4 MiB behind.
- HTTP ids and WebSocket stream ids come from one counter, so they never collide.

**Forwarded headers** (everything else is dropped):
- Requests: `content-type`, `accept`, `accept-encoding`, `origin`, `if-none-match`, `if-modified-since`, and `access-control-request-*`.
- Responses: `content-type`, `content-encoding`, `cache-control`, `etag`, `last-modified`, `vary`, `retry-after`, and `access-control-*`.

`set-cookie` is never forwarded.

## Land URLs

- **The default.** A Land is served at `<landId>.<LAND_BASE_DOMAIN>`, for example `https://7.lands.example`.
- **Own domain.** A Land owner may also verify a domain of their own (`PUT /lands/<landId>/domain` with a DNS TXT record `_linked-realms.<domain>` = `land=<landId>`). The relay then serves the Land there too, and the Directory's `url` uses it.
- **What the relay adds to every Land response:**
  - `Content-Security-Policy: frame-ancestors <Shell origins>`. Land UIs load only inside the Shells the relay's operator lists.
  - `X-Content-Type-Options: nosniff`.
- **Errors.** While the Land is offline, its pages get a short HTML page with status `503`.
- **Relay-only routes.** `/online`, `/stats` and `/health` exist only on the relay's own host, never on a Land's.
