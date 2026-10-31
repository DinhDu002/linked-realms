# 0013 — The Node's interfaces: P2P, public RPC, and one thread that owns the Node

Status: accepted, 2026-10-31 — in step 2C item 15 (plan `docs/plans/phase-2c-the-chain.md`), under the authority the project owner gave for step 2C's items. The values marked as defaults are not yet confirmed by the project owner.

## Context

Items 11 to 14 built the Node's chain, mempool, P2P and pruning as plain synchronous code: `Chain` over `redb`, `Mempool`, and `p2p::Node`, which decides, over `trait Network`, which moves bytes (`Tcp` with std threads). Item 15 adds the public JSON-RPC that browsers, Shells, Lands and the Dashboard call, and the Checkpoint intake by RPC. The plan named `jsonrpsee` (async, on tokio), CORS and per-client rate limits, the method list, and an index for `lr_getAddressTxs` (Question 7). It left open how the async RPC reaches a Node that is not thread-safe, the limits, the error codes and the JSON shapes. The protocols are `docs/protocols/node-p2p.md` and `docs/protocols/node-rpc.md`.

## Decisions

1. **One thread owns the Node** (`crates/node/src/run.rs`). `Running` moves the `p2p::Node` and its `Tcp` onto a thread of its own, which does one thing at a time: a P2P event, a tick once a second, or an RPC call sent to it as a closure over a channel. A `Waker` wakes the thread out of its wait on the network when a call comes. So the Node needs no lock, every read sees one state between two events, and the P2P code stays synchronous.
   - Rejected: a `Mutex` around the Node (every RPC read would wait on a whole Block's apply anyway, and the lock would spread through the P2P code); an async rewrite of the Node (a large change for no gain at one Block a minute).
   - Ceiling: all waiting calls run before the next event, so a flood of calls holds up other Nodes' messages; the rate limit bounds it.
2. **The RPC server** is `jsonrpsee` 0.26.1's low-level API on our own tokio listener, so each request carries its client's IP (`Server::start` does not give it to the methods). It runs on a runtime of 2 worker threads inside the process. HTTP and WebSocket share the port. Defaults: listen on `127.0.0.1:9445`; at most 128 connections; requests up to 64 KiB; no batches; 16 subscriptions on one WebSocket.
3. **CORS by hand**, not `tower-http`: a preflight `OPTIONS` gets `204` with `POST, OPTIONS`, `content-type` and a day's `Max-Age`, and every answer carries `Access-Control-Allow-Origin: *`. Nothing on the listener uses a cookie or a credential, so any origin may call it.
4. **Rate limit: a token bucket per client**, as an RPC middleware, so a WebSocket's calls count as well as HTTP's. Defaults: 10 calls a second, up to 50 at once; a client is an IPv4 address or an IPv6 /64; at most 10,000 tracked, a new one taking the place of one whose bucket filled again. Behind a proxy every client is the proxy, so the Public node (item 18) decides how the proxy passes the client's address on; trusting a forwarded header is not done until then.
5. **Error codes follow EIP-1474** from -32000: -32000 a Checkpoint the rules refuse, -32002 a Block's body not held, -32003 a refused transaction with `{reason}`, -32005 over the rate limit. `jsonrpsee` answers a batch with its own -32005 ("batches not supported"), which is kept: both mean "send less".
6. **JSON:** amounts, fees, fee rates and a header's nonce as decimal strings (they pass 2^53); other integers as numbers; bytes as lowercase hex without `0x`; addresses in their text form; camelCase names; `null` for not found.
7. **Subscriptions** come from one broadcast of the headers that join the best chain, lowest first, at most the last 256 for one change; a subscriber that falls more than 256 behind is closed with an error and reads what it missed. A reorganisation sends the new branch's headers again from where it parts, so a client keeps headers by height.
8. **The transaction index** (Question 7): two `redb` tables, `txs` (id → Block id and place) and `addr_txs` (tree key of the address, height, place). They are written when a Block is applied and removed when it is undone or pruned, so they hold exactly the best chain's Blocks whose bodies the Node holds; a state snapshot clears them. Block rewards are not indexed: a reward is in the header, and the Dashboard reads headers.
9. **No admin method on the public listener.** `node_info`, `lr_getConnections`, `lr_addNode` and every `mine_*` method come with the control listener (item 17), and a test lists the public methods exactly.
10. **Ports, proposed:** P2P 9444 and public RPC 9445; neither is published by the Land's compose stack.

## Consequences

- The RPC adds `jsonrpsee`, `tokio`, `hyper`, `http`, `tower`, `serde`, `serde_json` and `hex` to `crates/node`; `crates/core` and the WebAssembly build are unchanged.
- The `lr-node` binary (item 16) starts `Running` and `Rpc` with its settings; the RandomX verifier for real networks comes with it.
- A Public node needs a proxy that limits by the real client, and the Caddy vhost (item 18, the project owner).
- Ceilings recorded in the plan: a page of `lr_getAddressTxs` reads one body per Block in it; `Mempool::get` scans every held transaction; `lr_estimateFee` goes by fee rate alone, not nonce order.
