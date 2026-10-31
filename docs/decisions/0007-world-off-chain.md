# 0007 — The world lives off the chain

Status: accepted, 2026-10-29 — by the project owner

Supersedes ADR 0002 (on-chain Characters and soulbound Land tokens) and the on-chain parts of ADR 0004 (Delegations checked against `Land.ownerOf`, adjacency read from on-chain coordinates).

## Context

ADR 0006 gives linked-realms its own chain. It left open what goes on that chain besides Gold. The contracts also held Characters with key–value stats, Lands with spiral coordinates, and, later, items and NPCs. The project owner wants a newcomer to be able to host a Land and let others walk around it without owning any Gold. Every Land may also have its own rules (ADR 0008).

## Decisions

1. **The chain holds only money (P8).** Gold balances, nonces and public keys. Anything else on chain would cost Gold to create, which would lock newcomers out, or would need a free transaction type with its own anti-spam proof of work.
2. **Lands are registered with the Hub.**
   - The Land owner signs the registration with their Character key. It costs nothing.
   - The Hub gives the Land the next free cell of the spiral and keeps it in the Directory.
   - One Land per Character, and a Land is never transferred. The Hub enforces both.
   - Each Land is one cell with four Gates. How large a Land is inside, and what it holds, is up to its owner.
   - The trade-off: the company decides the map. On-chain Lands would not protect owners much more, because the Hub can already remove a Land from the Directory, and a removed Land is unreachable either way.
3. **Hub rules against Land spam.** Character keys are free, so "one Land per Character" alone limits nothing. The values can be tuned:
   - A Land gets a cell only once its Map server is running: reachable, with a valid Delegation.
   - At most 3 new Lands per network address per day.
   - A Land offline for 30 days in a row loses its cell, and the cell goes to the next new Land. A returning Land gets a new cell at the edge of the spiral. Its data on its owner's server is untouched.
4. **Character names are kept by the Hub.** A name is free, at most 32 characters and not unique. The Shell shows it next to the start of the address. There is no moderation for now; it can be added later.
5. **Land items stay in their Land.**
   - A Land owner creates their own items and keeps them in their Land's records, usable only in that Land.
   - Buying one is a Gold payment on chain, and its memo can name the item.
   - If the Land closes or cheats, the items are lost; the chain proves only that the payment was made.
6. **No shared Character stats.** Each Land sets its own. No one can be trusted to raise a stat that every Land honours: the chain cannot see inside Lands, the Hub does not judge play, and Lands do not trust each other (P1). Shared stats can come later only through a network upgrade with a rule the chain can check, for example burning Gold.
7. **Quests** are jobs a Land offers to visiting Characters and NPCs, under that Land's rules, rewarded in Gold.
   - The Land owner's key lives in the Shell, so automatic payouts come from an NPC acting as treasurer on the owner's server (P2).
   - The chain cannot force a Land to pay. Escrow is a later idea.
8. **NPCs are not recorded anywhere.**
   - An NPC is a Character another Character creates to work for it, with its key on the owner's server.
   - Neither the chain nor the Hub knows who owns it.
   - It travels with a Travel ticket like any Character, declares at arrival that an AI drives it, and names its own payout address. Quest rewards therefore go straight to the owner, and the NPC keeps only pocket money.
   - Losing an NPC's key loses only that pocket money, so recording ownership would buy little. A Hub record was considered and dropped: owners can make new Characters for free, so it would not stop abuse.
   - An owner-signed statement that the NPC carries can be added later.
   - An AI that makes its own key is simply a Character.
9. **Every Land runs a Node by default.** The Node ships in the Docker stack and is on by default. A Land owner may turn it off and read the chain through the Public node or another Node. A Mine needs a local Node.

## Consequences

- `PlayerRegistry`, `Land` and the indexer go away. `hub-api` stores Lands, cells, owners, names and Delegations in PostgreSQL. Adjacency for Travel tickets comes from the Hub's own cells.
- If the Hub is down, travel and the Directory stop, but the chain and every Land keep running.
- Section 5.1 of PLAN.md no longer gives Characters four stats equal to 1. The reference Land kit may still show stats as its own.
