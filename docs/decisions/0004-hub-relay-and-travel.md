# 0004 — Hub, relay and travel between Lands

Status: accepted, 2026-10-29. Partly superseded on 2026-10-29: the Hub keeps Lands and cells itself (ADR 0007), identities are ML-DSA keys from the Shell (ADR 0008), and the Mining key is gone (ADR 0006).

## Context

Phase 1C connects player-hosted Map servers into one world. PLAN.md section 3.4 sketches the flows and section 3.5 (decision D4) fixes the connection rules: a TypeScript `hub-api`, a Node.js `ws` relay, the Land id in every URL, Hub-gated joins with offline ticket checks, online status from the relay link, cacheable Directory responses, per-session counters, bounded buffering, and a load-test harness with a non-JavaScript client. The research brief left open the ticket format, how a Map server proves which Land it hosts, how presence reaches `hub-api`, and how Gates behave.

## Decisions

1. **The Mining key is the Map server's only identity** (P2). A Land owner authorises it with a **Delegation**, an EIP-712 signature over `(landId, miningKey, issuedAt)` in the domain `linked-realms Hub`, version 1, the chain id. `hub-api` checks the signer against `Land.ownerOf` with viem's `verifyTypedData` on a public client, which also accepts smart-contract wallets (ERC-1271/6492). The newest `issuedAt` wins, so a Land owner can move their Land to a new machine by signing again.
2. **Travel tickets are EIP-712** `TravelTicket(player, landId, gate, expiresAt, nonce)`, signed by a `hub-api` key and valid for 60 seconds. Map servers verify them offline by recovering the signer and comparing it with `HUB_TICKET_SIGNER`, and accept each nonce once. This replaces the Phase 1A signed join message; the on-chain Character check moves to `hub-api`, which runs it before signing.
3. **One multiplexed link per Map server.** The Map server dials the relay once (`/host/<landId>`) and proves its Mining key by signing a challenge. Player HTTP matchmaking and WebSockets are carried over that link as numbered streams, so a home Map server needs no open port and the relay holds one socket per Land plus one per Player.
4. **Presence is read from the relay.** `hub-api` polls the relay's `/online` list (cached 2 seconds) instead of storing heartbeats. One relay process covers the up-to-1,000-Player tier; with several relay nodes this becomes TTL keys in Redis, as the research brief recommends.
5. **Sessions:** SIWE through viem, then a short-lived HMAC-signed session token. No cookies, so `hub-api` needs no CSRF handling.
6. **Gates:** each edge of a Land has one Gate, 2 tiles wide at the middle of the edge, stored in the map as `gate` objects (P6: maps are data). Standing on a Gate takes the Character to the Land at the neighbouring world coordinates, if one is online, arriving one tile inside that Land's opposite Gate. The Hub checks adjacency before issuing the ticket.
7. **Hiding a Land** removes it from the Directory, stops new tickets for it, and makes the relay drop and refuse its link. Only addresses in `HUB_ADMINS` can hide or unhide Lands.
8. **Storage:** PostgreSQL through `pg` (already in the dependency tree via Ponder), with plain SQL migrations run at start-up. Tests run the same SQL on PGlite, in process.
9. **Load testing uses k6** (`grafana/k6`, a Go engine) against a stub Map server, so the client is not the bottleneck.

## Consequences

- `hub-api` holds a signing key (`HUB_TICKET_KEY`). It grants entry only; it holds no assets. Rotating it means updating `HUB_TICKET_SIGNER` on every Map server, which is acceptable while all Map servers in stage 1 are run by the team or testers.
- If the relay is down, no Land is reachable and every Land shows offline. That is the cost of having no open ports on player machines.
- A Map server whose Delegation is replaced is dropped the next time it reconnects; the relay re-checks the Delegation on every new link.
