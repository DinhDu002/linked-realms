# Arrival at a Land

Status: mandatory (ADR 0008). Every Land checks arrivals this way, whatever language its Map server is written in. The reference implementation is `verifyTravelTicket` and `verifyArrival` in `packages/shared/src/hub.ts`, used by `packages/map-server`.

## What arrives

A Character, or an NPC runner, arrives with a **handoff** of two signed statements (`identity.md`):

1. **`ticket`**: a `linked-realms Travel ticket` from `POST /tickets` at the Hub, signed by the Hub's ticket key.
2. **`arrival`**: a `linked-realms arrival` signed by the Character's own key.
   - `Land` is the Land being entered and `Ticket nonce` is the ticket's `Nonce`.
   - `Driven by AI` is `yes` when a program such as an AI model drives the Character. It is self-declared: the Hub does not vouch for it.
   - The Shell always sends `no`. NPC runners must send `yes`.

The ticket's nonce is the challenge: the Hub makes it fresh, a Land accepts it once, and it is bound to one Land. Signing it proves the arriving party holds the Character's key.

## The Hub's ticket key

- A Land knows the address of the Hub's ticket key from its own configuration (`HUB_TICKET_SIGNER` in the reference kit).
- At start it fetches `GET <hub>/keys`, which returns `{ "ticket": { "address": "tlr1…", "publicKey": "<base64>" } }`.
- It uses that public key only if the key hashes to the configured address.
- Replacing the Hub's ticket key means changing that setting.

## Checks, in order

A Land refuses the arrival at the first failing check and reports the reason. The reasons below are the reference kit's error codes.

1. **`bad-ticket`**: the ticket's signature does not verify with the Hub's ticket key under `linked-realms/travel-ticket/v1`, or the ticket does not parse.
2. **`wrong-land`**: the ticket's `Land` is not this Land, or its `Gate` is not in 0–4.
3. **`expired`**: `Expires` is not later than now.
4. **`too-far-ahead`**: `Expires` is more than 120 seconds from now (tickets live 60 seconds).
5. **`before-start`**: `Issued` is earlier than the moment the Map server started. A restarted Map server has forgotten the nonces it saw, so it must not accept tickets from before.
6. **`reused`**: this ticket's `Nonce` was already accepted. Nonces are remembered until their ticket expires.
7. **`bad-arrival`**: the arrival's signature does not verify with its own `publicKey` under `linked-realms/arrival/v1`, or the arrival does not parse.
8. **`key-mismatch`**: the address derived from the arrival's `publicKey` is not the ticket's `Character`.
9. **`mismatch`**: the arrival's `Land` or `Ticket nonce` differs from the ticket's.

The nonce is recorded as used only when every check passes.

## Placing the Character

- `Gate` 1–4 places the Character just inside that Gate (north, east, south, west).
- `Gate` 0 means the Character came from the Directory, not through a Gate. The Land places it at its own spawn point.

## What a Land shows

- A Land shows the ticket's `Name` next to the Character, or the short form of the address when the name is empty.
- When `Driven by AI` is `yes`, it shows a visible marker on that Character to every Player (EU AI Act Article 50(1); ADR 0008 decision 7).

A Land may refuse a valid arrival for its own reasons, such as being full or a ban list. It must not accept an arrival that fails any check above.
