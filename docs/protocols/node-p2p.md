# Node to Node (P2P)

Status: mandatory for every Node of a network (ADR 0006, ADR 0013). Nodes find each other and swap headers, Blocks, transactions, Checkpoints and state snapshots this way. The reference implementation is `crates/node/src/p2p` (`message.rs` the bytes, `mod.rs` what a Node does with them, `tcp.rs` the connections); the tests are `crates/node/src/p2p/tests.rs`.

All integers are big-endian and fixed width, as in `crates/core`. Headers, Blocks, transactions and Checkpoints are the bytes of `docs/protocols/blocks.md` and `docs/protocols/transactions.md`; a Node checks every one of them itself.

## Connections

TCP, proposed port 9444. A Node behind NAT only dials out; it listens only when its owner asks it to. Each Node keeps at most 8 connections it dialed and takes at most 64 it did not.

## Frame

| Field | Bytes | |
|---|---|---|
| magic | 4 | the first 4 bytes of the network's genesis id, so a reset, which takes a new genesis, takes a new magic |
| command | 1 | below |
| length | 4 | of the payload, at most 2 MiB (2,097,152) |
| checksum | 4 | the first 4 bytes of `keccak256(payload)` |
| payload | length | |

A frame with a length above 2 MiB (refused before its payload comes), a wrong checksum or a payload that does not read as its command bans the sender; one with another magic, another network's Node, drops the connection without a ban. A command a Node does not know is skipped, so a later version can add commands.

## Messages

Counts are `u16`. An id is 32 bytes.

| Command | Name | Payload |
|---|---|---|
| 0 | `version` | protocol version `u32` (`1`) ‖ genesis id ‖ height `u64` ‖ listen port `u16` (0 if none) ‖ nonce `u64` (random, so a Node that dials itself sees its own) |
| 1 | `verack` | empty |
| 2 | `ping` | nonce `u64` |
| 3 | `pong` | the ping's nonce |
| 4 | `inv` | count ‖ Block ids (at most 500) |
| 5 | `getdata` | count ‖ Block ids (at most 16) |
| 6 | `notfound` | count ‖ Block ids (at most 16) |
| 7 | `getheaders` | count ‖ locator ids (at most 64): the best chain's ids: the tip and the 9 below it, then steps that double, down to the genesis |
| 8 | `headers` | count ‖ headers (at most 2,000) |
| 9 | `block` | the Block |
| 10 | `tx` | the transaction |
| 11 | `checkpoint` | height `u64` ‖ Block id ‖ signature (2,420 bytes, ML-DSA-44) |
| 12 | `getcheckpoint` | empty |
| 13 | `getnodes` | empty |
| 14 | `nodes` | count ‖ (IPv6 address, an IPv4 one mapped, 16 bytes ‖ port `u16`) (at most 1,000) |
| 15 | `getstatesnapshot` | height `u64` ‖ optional key (32 bytes): the account after which to start |
| 16 | `statesnapshot` | height `u64` ‖ more `u8` (0 or 1) ‖ count ‖ accounts (at most 1,000): address (34) ‖ balance `u64` ‖ nonce `u64` ‖ key length `u16` (0 for none) ‖ scheme ‖ key |

## Flows

1. **Handshake.** The Node that dials sends `version`; each side answers a `version` with `verack`. A `version` with another genesis, or the Node's own nonce, drops the connection without a ban. On `verack` a Node sends `getcheckpoint` (first: the Checkpoint decides whether the headers start a state snapshot), `getheaders` with its locator, and `getnodes`. Any other message before the handshake is done, or a second `version`, bans the sender.
2. **Headers first.** `headers` answers `getheaders` with up to 2,000 headers after the first locator id on the answering Node's best chain. A Node asks the peer for the Blocks it lacks, at most 16 on the way at once, and once a batch is in asks for the next headers. It stops at a header stamped more than 300 seconds ahead of its clock; each tick asks one idle peer for headers, in turn, so such a Block is taken once the clock catches up. A Block whose parent is unknown makes the Node ask for headers again.
3. **New Blocks.** A Node that takes a Block that moves its best chain sends `inv` with the new tip to every peer. A peer asks with `getdata`; a Block the Node does not hold comes back in `notfound`.
4. **Transactions and Checkpoints** are passed on once, to every peer but the sender, when the Node takes them (a transaction into its mempool, `docs/protocols/transactions.md`; a Checkpoint when it is the highest held). A refused transaction is no fault, because mempools differ. `getcheckpoint` is answered with the latest Checkpoint held, if any.
5. **Other Nodes.** `getnodes` is answered with up to 1,000 known addresses, those the Node finished `version` with first. A Node takes `nodes` only in answer to its own `getnodes`, and never an address with port 0, an unspecified or multicast IP, or a loopback IP from a Node that is not on loopback. It dials the least recently tried address first, again after 60 seconds; an address learned from another Node that never finishes `version` is forgotten, and seeds stay.
6. **State snapshot** (a pruning Node far behind, ADR 0015). A pruning Node whose tip is more than the Blocks it keeps below the latest Checkpoint stores the headers up to that Checkpoint without bodies, then asks one peer for the state at the Checkpoint's height with `getstatesnapshot`, part by part, each starting after the last key of the one before. A Node serves the state at a Checkpoint its best chain holds, not below what it pruned, and at most 1,440 Blocks below its highest Checkpoint, in the state tree's key order. A part with no account and no more means the peer does not serve that height. The asking Node checks the root against the Checkpoint's header before it replaces its state.

## Bans and drops

A ban is of the IP address, for 24 hours, at once: no honest Node sends any of these.

- a malformed frame (above), or a message out of turn;
- a Block or Checkpoint a rule refuses, or a Block on a branch already refused;
- headers a rule refuses during a state snapshot; a snapshot part out of key order, that says more follow but is not full, with more accounts than 50 a Block below the Checkpoint, or whose root is wrong.

A connection is dropped, without a ban, when: a frame has another magic, or another genesis or the Node's own nonce comes in `version`; the handshake takes more than 60 seconds; the peer sends no whole message for 180 seconds (it is pinged after 60); it sends none of the Blocks asked of it, or no snapshot part, for 120 seconds; or more than 32 MiB wait to be written to it.
