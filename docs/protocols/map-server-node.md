# Map server ↔ Node

Status: the reference Land kit's link between a Map server and its Land's Node (ADR 0014). The control API is `lr-node`'s own interface (ADR 0013); the reference implementation is `crates/node/src/control.rs`, with tests in `crates/node/src/control/tests.rs` and `crates/node/tests/lr_node.rs`. The rules of the Mine switch below are the reference kit's behaviour, not mandatory: each Land makes its own rules (ADR 0008). The switch line is parsed by `packages/shared/src/mine-switch.ts`, with vectors in `packages/shared/test-vectors/mine-switch.json`.

A Map server uses two listeners of its Node:

- **The control listener**, for the Mine and the Node's state. Only the Node's owner may call it (P5): in the reference kit that is the Map server, which switches the Mine only when the Land owner asks for it in the Land.
- **The public RPC** (`node-rpc.md`), to read the chain. It holds no key and serves no `mine_*` method. The Map server never asks the Node to sign anything.

## The control listener

`lr-node` serves it only when started with `--control`, on one of:

- **A Unix socket**, `--control unix:PATH`. This is the default when the Map server spawns `lr-node` itself, with the socket in `/data`. The Node makes the socket mode 0600 and refuses a path where another user could replace it. It serves only connections from its own user (the peer's uid), and needs no secret.
- **TCP**, `--control ADDR --control-secret FILE`, for a Node the Map server does not spawn (`NODE_CONTROL_URL`, `NODE_CONTROL_SECRET_FILE`). The file holds at least 32 random bytes, and both sides read the same file. `lr-node` refuses to start a TCP control listener without one, and checks the secret on every connection, loopback included.

Transport:

- JSON-RPC 2.0 over HTTP `POST` and over WebSocket. Subscriptions need a WebSocket. Batches are not served.
- On TCP, every HTTP request and every WebSocket upgrade carries `Authorization: Bearer <the file's bytes in lowercase hex>`, compared in constant time. Anything else gets HTTP 401 with `WWW-Authenticate: Bearer`, before any JSON-RPC.
- At most 32 connections are open at once, with the secret or not; more are closed as they come. A TCP connection that has not sent the secret within 5 seconds is closed.
- Amounts are decimal strings of base units; heights, threads and counts are numbers; ids are lowercase hex; addresses are their text form (`identity.md`).

The Node has one Mine, with the id `land` (one per Land in Linked Realms; ADR 0014). The id stays in the API as a field. The Mine is off whenever `lr-node` starts: nothing about "on" is stored (P5).

## Methods

ADR 0013 also names `lr_getConnections` and `lr_addNode` for this listener; they are not built yet.

**`node_info()`**: the Node's state and what its Mine may use.

```json
{ "height": 1234, "tip": "5f0c…", "connections": 8, "synced": true, "maxThreads": 7, "memoryAvailableMiB": 6120 }
```

- `maxThreads` is `max(1, cores − 1)`, lowered by `MINE_MAX_THREADS` if it is set.
- `memoryAvailableMiB` is `null` where the Node cannot read it.

**`mine_status({ "id": "land" })`**: what the Mine is really doing, not what was asked.

```json
{ "id": "land", "state": "on", "threads": 2, "mode": "fast", "hashRate": 1180.5, "blocksWon": 3, "rewardAddress": "tlr1…" }
```

- `state` is `off`, `starting` (the RandomX dataset is being built) or `on`.
- `mode` is `fast` or `light` while on, and `null` while off or starting.
- `hashRate` is hashes a second over the last 10 seconds.
- `blocksWon` counts the Blocks this Mine found that the Node took into its best chain since it started.
- `rewardAddress` is the address of the last start, or `null` before the first.

**`mine_start({ "id": "land", "rewardAddress": "tlr1…", "threads": 2, "mode": "auto" })`** returns the status.

- `threads` is 1 to `maxThreads`.
- `mode` is `auto` (fast if at least 2.5 GiB is available, else light), `fast` or `light`.
- The Node must be synced. A start while the Mine runs stops it first, then starts it with the new settings.

**`mine_stop({ "id": "land" })`** returns the status, once the threads have stopped.

**`mine_subscribe({ "id": "land" })`** (WebSocket; `mine_unsubscribe` ends it) sends notifications:

- `mine_status`: the status, once at the start, then on each change, at most every 2 seconds;
- `mine_blockFound`, once the Node has taken a Block this Mine's own `submit` produced into its best chain (P3):

```json
{ "id": "land", "height": 1240, "hash": "0a91…", "reward": "500004000", "rewardAddress": "tlr1…", "time": 1793232000 }
```

- `reward` is the Block reward at that height plus the Block's fees.
- A win is found by the Block's id, not by its reward address. Addresses are public, so a Block from another Node that names the same address is not this Mine's win.

## Errors

| Code | Message | When |
|---|---|---|
| -32002 | `node-unavailable` | the Node is not running, or not synced for `mine_start` |
| -32602 | `bad-address` | `rewardAddress` is not an address |
| -32602 | `bad-threads` | `threads` is 0 or more than `maxThreads` |
| -32602 | `unknown-mine` | a Mine id other than `land` |
| -32602 | (jsonrpsee's) | other malformed parameters |
| -32601 | | no such method |
| HTTP 401 | | a TCP request without the secret |

## Flows

1. **Start.** The Map server spawns `lr-node` with `--control unix:/data/…` as a supervised child, or connects to `NODE_CONTROL_URL` with the secret. It calls `mine_subscribe`, keeps the Mine's status and asks `node_info` every 2 seconds. If the Node stops, the Map server restarts it, and the Mine stays off.
2. **The Land owner switches the Mine** (the step 2C plan, flow 2). The Land UI sends the Map server a signed switch (below). If every check passes, the Map server calls `mine_start` with the Land owner's address as `rewardAddress`, or `mine_stop`. It answers the Land UI, broadcasts the new state, and logs "Mine ON: threads, mode, reward address" or "Mine OFF".
3. **A won Block** (flow 3). On `mine_blockFound` the Map server broadcasts `MineWon` to every connected client. Every Land UI shows the win.

## The switch (reference Land kit)

The Land owner switches the Mine in their own Land. The request is a `linked-realms Land message` (`identity.md`) that the Land UI asks the Shell for with `signMessage` (`shell-land-ui.md`), so the Shell shows it in its own prompt and signs it only on Approve (P6). Its `Message` is one line of printable ASCII, so the prompt shows it as written:

```
linked-realms Mine switch; Map server key: <address>; Mine: on; Threads: 2; Nonce: <32 hex>
```

- The fields come in this order, each once, with `; ` between them.
- `Map server key` is the Map server's own address. `Mine` is `on` or `off`.
- `Threads` is a decimal integer with no leading zeros, of at most 4 digits. It is 1 or more when on (at most `maxThreads`, which the Map server checks), and `0` when off.
- `Nonce` is 32 lowercase hexadecimal characters: the session's challenge.
- Anything else is refused, such as another case, extra spaces, a trailing `;` or a line feed.

A full statement, as the Shell signs it:

```
linked-realms Land message
Land: 7
Land URL: https://7.lands.example.org
Character: tlr1…
Issued: 1793232000
Message: "linked-realms Mine switch; Map server key: tlr1…; Mine: on; Threads: 2; Nonce: 00112233445566778899aabbccddeeff"
```

Signed, it is about 5.3 KB, under the relay's 16,384-byte frame limit for players (`packages/relay/README.md`), so the switch works from a phone through the relay.

**The challenge.**

- The Map server keeps one random challenge in memory for each session of the Land owner, so a phone and a laptop do not spend each other's. It sends it only in that session's `MineState`, with its own address as `map_server_key`.
- A challenge expires 300 seconds after it was issued, the same window as `Issued`. When it is spent or expires, the Map server sends that session a `MineState` with a fresh one at once, whether or not the Mine changed.
- It is spent only by a switch whose signature, Land and time pass and whose `Nonce` equals it; a wrong nonce spends nothing. A replayed switch fails, because its nonce is spent.

**Checks, in order** (the `MineSwitchResult` code in brackets):

1. at most one switch per 2 seconds per session, and one verification in flight (`rate-limited`);
2. the session is the Land owner's (`is_owner` from the Hub's `land.owner`) (`not-owner`);
3. `verifyStatement(signed, "land-message")` passes, in `identity.md`'s order: the signature before anything is parsed, then the grammar, then `Character` is the signer (`bad-statement`);
4. the statement's `Character` equals `land.owner` (`not-owner`); `Land` is the Land this Map server serves (`bad-statement`); `Issued` is within 300 seconds of the Map server's clock (`stale`);
5. the `Message` parses as a switch and `Map server key` is this Map server's own address (`bad-statement`); `Nonce` equals the session's unexpired challenge, which is spent here (`wrong-nonce`);
6. for `on`, `Threads` is 1 to `maxThreads` (`bad-threads`); then the Node's `mine_start` or `mine_stop` succeeds, for `off` too (`unavailable` if the Node is down, not synced or refuses).

Only the Land owner's sessions reach the signature, at most one every 2 seconds each, so nothing is read from the statement before its signature passes.

`Land URL` is not checked: with its own domain the Shell may load the Land from a host other than the Hub's `url`, and `Land` already binds the statement to the Land.

## Messages to the Land UI (`land.proto`)

The reference kit's game protocol (`packages/shared/proto/linked_realms/land/v1/land.proto`) carries the switch and the Mine's state:

- `ClientMessage.mine_switch` (`MineSwitch { signed }`): the signed Land message.
- `ServerMessage.mine_state` (`MineState`), sent to every client after `welcome`, on each change, and about every 2 seconds while on, and to a Land owner's session whenever its challenge is renewed. `challenge` and `map_server_key` are only in the Land owner's copy. `mode` is empty while off or starting. `status` is `off`, `starting`, `on`, or `unavailable` while the Map server cannot reach the Land's Node, or while the Mine is off and the Node has no other Node or is not synced. A Mine that runs is reported as running, whatever the Node's sync (P5).
- `ServerMessage.mine_switch_result` (`MineSwitchResult { ok, code }`), to the session that sent the switch.
- `ServerMessage.mine_won` (`MineWon { height, reward, reward_address }`), to every client.

A visitor can verify none of it: a Land can fake `MineState` and `MineWon` (P1). What the Land owner sees from their own Node (its console and `mine_status`) is what really runs; the Land UI's animation and "+N GOLD" are the Land's statement, not proof. Gold is only what the chain says.
