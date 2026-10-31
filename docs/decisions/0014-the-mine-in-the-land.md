# 0014 — The Mine in the Land: the switch and the win

Status: accepted, 2026-10-31 — in step 2C item 21 (plan `docs/plans/phase-2c-the-chain.md`). The project owner decided the switch and the win on 2026-10-30 (the plan's decisions 1 and 2) and "No Land, no Mine" (Answer 19, changed by ADR 0015 decision 3). The details marked as defaults were chosen under the authority the project owner gave for step 2C's items and are not yet confirmed by them. It supersedes ADR 0006 point 11 for Linked Realms.

## Context

Each Land runs a Node, and its Mine mines Gold by Proof of Work (ADR 0006). P5 says a Mine runs only when its owner turns it on, with a CPU limit, and never covertly. Lands are not trusted (P1), Players' keys stay in the Shell (P2), and a Land's code runs only in its frame, with every signing request shown by the Shell (P6). The project owner decided that the Land owner switches the Mine in their own Land, signing the request in the Shell, and that everyone in the Land sees the Mine work and win. LR's own `lr-node mine` command (ADR 0015) mines without a Land; this ADR is about the game.

## Decisions

1. **No Land, no Mine.** This is a Linked Realms rule, not an LR rule.
   - In the game a Mine exists only as part of a Land: that Land's `lr-node` runs it, the Land owner switches it in the Land, and its rewards go to the Land owner (Answer 14). So each Land has one Mine, with the id `land`.
   - The reference Land kit and the Shell offer no Mine without a Land. A newcomer without a Land gets Gold in the game only by being sent some.
   - LR cannot enforce this, and does not try (ADR 0015 decision 3).
   - Supersedes ADR 0006 point 11 ("A Mine can run before its Player has a Land") for Linked Realms.
2. **The switch is a Land message signed in the Shell.**
   - The Land UI asks the Shell for `signMessage` with one line of printable ASCII: `linked-realms Mine switch; Map server key: <address>; Mine: on; Threads: 2; Nonce: <32 hex>` (`docs/protocols/map-server-node.md`). The Shell shows it in its own prompt and signs it only on Approve.
   - Neither the Shell nor `identity.md` changes: a Land message already carries the Land, the Land URL, the Character and `Issued`.
   - The line is strict both ways (`parseMineSwitch` in `packages/shared`, with vectors). Default: `Threads` has at most 4 digits; the Map server checks it against the Node's `maxThreads`.
   - Rejected: a new statement kind for the switch, which would change the Shell and `identity.md` for one Land feature; a switch in the Shell's own page, which the project owner placed in the Land.
3. **The Map server checks the switch, then tells its Node.**
   - A challenge per session of the Land owner, sent only in that session's `MineState` and spent when a switch uses it, stops replays without an extra round trip. It expires after 300 seconds, like `Issued`, and the session gets a fresh one at once when it is spent or expires.
   - The rate and the session's owner are checked first, so only the Land owner's sessions reach the signature. The signature is then checked before anything in the statement is read, as `identity.md` orders a verifier. Then come the Land owner, the Land, the time, the line and the challenge, the threads and the Node.
   - The reward address is always the switch's `Character`, which must be the Hub's `land.owner`.
   - Only the Map server can start the Mine: it holds the Node's control socket, or the control secret for an external Node. The public RPC serves no `mine_*` method.
   - Nothing about "on" is stored: a restart of the Node or the container leaves the Mine off (P5).
   - These are the reference kit's rules, not mandatory: each Land makes its own (ADR 0008).
   - Rejected: a nonce from the clock alone, which a replay within the time window would pass; one challenge per Land, which a phone and a laptop of the same Land owner would spend for each other.
4. **Everyone sees a win, and nobody can verify it.**
   - The Node reports a win only for a Block its own Mine produced, by the Block's id, once that Block is in its best chain. The Map server tells every client, and every Land UI shows the Mine's ring and "+N GOLD". N is the Block reward at that height plus the Block's fees, from the Node, never a constant.
   - While the Mine is starting or on, the Land UI animates it, so the Mine shows that it mines (P5).
   - Rejected: finding wins by reward address. Addresses are public, so a Block from another Node, or from the Land owner's second machine, that names the same address would flash here.
   - A Land can fake its Mine's state and wins (P1). The P5 claim covers what the Land owner sees from their own Node: its console log and `mine_status`, which report what really runs. To a visitor the animation is the Land's statement, not proof; Gold is only what the chain says.

## Consequences

- Every switch costs one prompt in the Shell. A Player who denies it meets the Shell's limits (busy for 10 seconds, blocked after 3 refusals since the Land loaded).
- A signed switch is about 5.3 KB, under the relay's 16,384-byte frame limit for players, so the switch works from a phone through the relay.
- `land.proto` gains `MineSwitch`, `MineState`, `MineSwitchResult` and `MineWon` in its reserved slots (items 22 and 23 use them).
- A Land owner who wants to mine from a machine without a Land can run LR's `lr-node mine`; the game does not offer or show it.
