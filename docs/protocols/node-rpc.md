# Node RPC (public)

Status: the public interface of `lr-node` (ADR 0013). Shells, Lands, the Dashboard and anyone else read the chain and send transactions and Checkpoints through it. It holds no key and changes nothing but the mempool and the Checkpoints, both checked by the same rules as from another Node. The reference implementation is `crates/node/src/rpc.rs` (the server) and `crates/node/src/run.rs` (the thread that owns the Node); the tests are `crates/node/src/rpc/tests.rs`.

The admin methods (`node_info`, `lr_getConnections`, `lr_addNode`) and every `mine_*` method are never served here. They are only on the control listener (item 17), a Unix socket or an authenticated listener.

## Transport

- JSON-RPC 2.0 over HTTP `POST` and over WebSocket, on one port: proposed 9445, on `127.0.0.1` by default. A Public node puts it behind a proxy.
- A request is at most 64 KiB. Batches are not served (error -32005). At most 128 requests or WebSockets at once, and 16 subscriptions on one WebSocket. At most 256 sockets are open, idle ones included; past that, new connections wait to be accepted. A WebSocket is pinged every 30 seconds and closed if no answer comes within 40.
- **CORS**, because browsers call it: every answer carries `Access-Control-Allow-Origin: *`. A preflight `OPTIONS` gets `204` with `Access-Control-Allow-Methods: POST, OPTIONS`, `Access-Control-Allow-Headers: content-type` and `Access-Control-Max-Age: 86400`. Nothing here needs a cookie or a credential.
- **Rate limit:** each client has a bucket of calls that fills by 10 a second up to 50; a call over it gets -32005. A client is an IPv4 address, or an IPv6 /64. At most 10,000 clients are tracked: past that a new client takes the place of one whose bucket filled again, or is refused until one does. Behind a proxy, each address `--rpc-proxy` names is trusted to write `X-Forwarded-For`: the client is the rightmost address in that header that is not such a proxy, walking left past each proxy it names, and the connection's own address when it does not come from one. Proxies are named by address, not by range. The header from any other address is ignored.

## Conventions

- Amounts, fees, fee rates and a header's nonce are decimal strings (they pass 2^53). Heights, timestamps (Unix seconds), transaction nonces, places and counts are numbers.
- Ids, roots, Targets, signatures, keys, memos and transaction bytes are lowercase hex without `0x`.
- Addresses are their text form (`docs/protocols/identity.md`).
- Field names are camelCase. Something not found is `null`, not an error.

## Objects

**Header**

```json
{
  "id": "5c1f…",
  "height": 25,
  "prevId": "9a07…",
  "timestamp": 1793318400,
  "target": "0000ffff…",
  "txRoot": "…",
  "stateRoot": "…",
  "rewardAddress": "tlr1…",
  "nonce": "18446744073709551615"
}
```

**Transaction**: `id`, `sender`, `nonce`, `fee`, `size` (its bytes), and `kind`:

```json
{ "id": "…", "sender": "tlr1…", "nonce": 2, "fee": "25170", "size": 2517,
  "kind": "transfer", "to": "tlr1…", "amount": "100000000", "memo": "" }
```

```json
{ "id": "…", "sender": "tlr1…", "nonce": 3, "fee": "37870", "size": 3787,
  "kind": "rotation", "newKeyScheme": 1, "newKey": "…" }
```

**Placed transaction**: where the best chain holds it.

```json
{ "tx": { "id": "…", "kind": "transfer", "…": "…" },
  "block": { "id": "…", "height": 22, "place": 0 } }
```

**Account**: `{ "balance": "1000", "nonce": 0, "hasKey": false }`.

## Methods

| Method | Params | Result |
|---|---|---|
| `lr_getInfo` | | `{ networkId, genesis, height, tip, time, latestCheckpoint: { height, blockId } \| null, pruned, archive, connections }` |
| `lr_getHeader` | height or Block id | Header on the best chain at that height, or by id on any branch; `null` if not known |
| `lr_getHeaders` | from height, count | the best chain's Headers from that height, at most 2,000 |
| `lr_getBlock` | height or Block id | `{ header, txs: [Transaction] }`; `null` if not known; -32002 if its body is not held (pruned, or not taken yet) |
| `lr_getAccount` | address, includeMempool (optional, false) | Account on the tip; with the mempool, as it would be after the sender's held transactions; `null` if it does not exist |
| `lr_getTransaction` | transaction id | `{ tx, block: null }` if held in the mempool; a Placed transaction if on the best chain; `null` otherwise |
| `lr_getAddressTxs` | address, before (optional, `{ height, place }`) | up to 20 Placed transactions sent or received by the address, newest first, below `before`; pass the last one's `block` to read the next page |
| `lr_getMempoolInfo` | | `{ count, bytes, maxBytes, minFeeRate, dust }` |
| `lr_estimateFee` | | the fee rate in base units a byte that would put a transaction in the next Block now |
| `lr_getCheckpoint` | | `{ height, blockId, signature }` of the latest Checkpoint held, or `null` |
| `lr_sendTransaction` | transaction bytes | its id; one already held counts as sent |
| `lr_submitCheckpoint` | `{ height, blockId, signature }` | `true`; -32000 with the rule if refused |

Notes:

- `pruned` is the height below which this Node no longer holds bodies (0 for none); `archive` is true if it never prunes. `time` is the tip's timestamp.
- `lr_getAddressTxs` counts transfers to and from the address and its key rotations, not Block rewards, and only what the Node holds bodies for: a pruning Node forgets the index below what it pruned.
- `lr_estimateFee` fills a Block with the held transactions by fee rate, leaving room for the largest transfer; if they all fit it is the minimum rate, otherwise one above the rate of the first that does not. It does not look at nonce order.
- A Checkpoint is checked against the network's key and taken even if its Block is not known yet: it is held, the branches that contradict it are cut, and it applies when its Block comes. A lower one than the latest is taken and the latest stays. One higher than the latest held is passed on to the other Nodes.
- A sent transaction is checked by the rules and the mempool's policy (`docs/protocols/transactions.md`, "Mempool") and passed on to the other Nodes.

## Subscriptions (WebSocket only)

| Subscribe | Params | Notification | Unsubscribe |
|---|---|---|---|
| `lr_subscribeBlocks` | | `lr_block`: a Header | `lr_unsubscribeBlocks` |
| `lr_subscribeAddress` | address | `lr_addressTx`: a Placed transaction | `lr_unsubscribeAddress` |

- `lr_block` comes for each Block that joins the best chain, lowest first. After a reorganisation the new branch's Blocks come again from where it parts; a client that keeps Headers by height replaces what it had. At most the last 256 come for one change, so a client that sees a gap in the heights reads what it missed with `lr_getHeaders`.
- `lr_addressTx` comes for each transaction of a joining Block that the address sent or received. A Block whose body the Node does not hold (one below a state snapshot) tells nothing.
- A client that does not read fast enough falls more than 256 Headers behind, and the subscription closes with an error; it reads what it missed and subscribes again. A subscription also closes with an error when the Node stops, and a new one is refused (-32603).

## Errors

| Code | When | Data |
|---|---|---|
| -32700 | the request is not JSON | |
| -32600 | not a JSON-RPC request | |
| -32601 | no such method, including every admin and `mine_*` method | |
| -32602 | a param is missing, of the wrong type, or not an address, an id or transaction bytes | |
| -32603 | the Node failed inside, or a subscription was asked over HTTP | |
| -32000 | a Checkpoint the rules refuse | |
| -32002 | the Block's body is not held here | |
| -32003 | the transaction is refused | `{ "reason": … }`, one of `rule`, `fee-too-low`, `dust`, `nonce-gap`, `too-many`, `replacement-too-cheap`, `mempool-full` |
| -32005 | over the rate limit, or a batch | |
| -32006 | more than 16 subscriptions on one WebSocket | |
| -32007 | a request above 64 KiB (over HTTP with status `413`) | |
| -32009 | the server is busy: a WebSocket client that does not read its answers | |

The codes from -32000 follow EIP-1474; -32006 to -32009 are the server's own (`jsonrpsee`). Over HTTP a few answers are not JSON-RPC: `429` past 128 connections, `415` for a body that is not `application/json`, `405` for a method other than `POST` or `OPTIONS`.
