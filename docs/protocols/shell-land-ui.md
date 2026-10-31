# Shell ↔ Land UI API (`api: 1`)

Status: mandatory (ADR 0008). A Land UI that wants Players must speak it. The reference implementations are `packages/shell` and `packages/client/src/shell.ts`.

## Frame

- The Shell loads a Land UI in an iframe whose `src` is the Land's `url` from the Hub's Directory. The Land never chooses where it is loaded.
- The iframe has:
  - `sandbox="allow-scripts allow-same-origin allow-pointer-lock"`
  - `allow=""`
  - `referrerpolicy="no-referrer"`
- The Land runs on its own origin, so it cannot read the Shell's page, storage or keys.
- Every response the relay serves for a Land carries `Content-Security-Policy: frame-ancestors <Shell origins>` (`map-server-hub-relay.md`).
- A Land UI must not ask for a Player's password or 24 words. The Shell asks for them only in its own page, never inside a frame.

## Connecting

1. Each time the iframe fires `load`, the Shell gets a fresh arrival handoff (a new Travel ticket and arrival statement, `arrival.md`).
2. It creates a `MessageChannel` and posts `{ "type": "linked-realms/connect", "api": 1 }` to the iframe's `contentWindow`, with the Land's exact origin as the target origin and `port2` as the transferred port.
3. The Land UI listens for `message` events on `window`. It accepts the connect message only when `event.source === window.parent` and `event.data.type === "linked-realms/connect"`, then keeps `event.ports[0]`.
4. All further messages travel over that port as plain objects (structured clone). Each has a string `type`. Unknown types are ignored. The Shell drops any message whose JSON form is larger than 64 KiB.

The Shell reloads a frame at most once every 5 seconds. A faster reload loop shows "This Land keeps reloading" and stops.

## Shell to Land UI

**`init`** is sent once, right after connecting:

```json
{
  "type": "init",
  "land": { "landId": 7, "url": "https://7.lands.example", "ownerName": "Mai" },
  "character": { "address": "tlr1…", "name": "Lan" },
  "handoff": {
    "ticket": { "statement": "…", "publicKey": "…", "signature": "…" },
    "arrival": { "statement": "…", "publicKey": "…", "signature": "…" }
  }
}
```

The Land UI sends `handoff` to its Map server as its first message. How it does that is the Land's own business; the reference kit uses a WebSocket and Protocol Buffers.

**`travelRefused`** answers a `travel` the Shell could not carry out:

```json
{ "type": "travelRefused", "direction": "east", "reason": "no-land", "landId": 8 }
```

`reason` is one of:
- `no-land`: no Land in that cell;
- `offline`;
- `locked`: the Shell is locked and the Player cancelled the unlock;
- `busy`: another travel is in progress;
- `rate-limited`;
- `error`.

`landId` is present when a Land exists in that cell.

**`signResult`** answers `signMessage` or `pay`:

```json
{ "type": "signResult", "id": "a1", "signed": { "statement": "…", "publicKey": "…", "signature": "…" } }
{ "type": "signResult", "id": "a2", "txId": "3f9c…" }
{ "type": "signResult", "id": "a1", "error": "denied" }
```

`signed` answers `signMessage`, `txId` answers `pay`. `error` is one of:
- `denied`: the Player said no or closed the prompt;
- `busy`: another request is open;
- `blocked`: this Land was refused 3 times since it loaded;
- `invalid`: a malformed request;
- `failed`: a `pay` the Shell could not make, or the Node refused;
- `locked`: the Player cancelled the unlock.

## Land UI to Shell

**`travel`** asks the Shell to take the Character through a Gate:

```json
{ "type": "travel", "direction": "east" }
```

- `direction` is `north`, `east`, `south` or `west`.
- The Shell accepts at most one per second.
- It looks up the neighbouring cell (`gate-travel.md`), gets a ticket with `from` set to this Land, and loads the neighbour's frame. Otherwise it answers `travelRefused`.

**`signMessage`** asks the Player to sign text for this Land:

```json
{ "type": "signMessage", "id": "a1", "text": "I agree to the rules of Mai's Land." }
```

- `id` is a string of at most 64 characters. `text` is at most 1,000 code points; any longer request is `invalid`.
- The Shell builds a `linked-realms Land message` statement (`identity.md`) with this Land's id and URL, the Character and the current time. It shows the statement in its own prompt, outside the frame.
- Only after the Player approves does it sign and return `signed`.
- Limits:
  - One request may be open at a time.
  - After a refusal, the Shell answers `busy` for 10 seconds.
  - After 3 refusals since the frame loaded, it answers `blocked`.
  - A cancelled unlock counts as a refusal, whether a `signMessage` or a `travel` asked for it. While those limits hold, the Shell does not ask for the password on this Land's behalf: a `travel` that needs it gets `locked` at once.

**`pay`** asks the Player to pay Gold from the Character:

```json
{ "type": "pay", "id": "a2", "amount": "1.5", "recipient": "tlr1…", "memo": "Lantern" }
```

- `id` is as for `signMessage`. `amount` is GOLD as a string: digits, then optionally a dot and up to 8 digits, more than 0. `recipient` is a Character address. `memo` is optional text of at most 80 UTF-8 bytes. Nothing is trimmed or rounded: any other request is `invalid`, with no prompt.
- The Shell reads the Character's account from its Node and sets the fee itself: the Node's fee rate times the transfer's size. It shows the payment in its own prompt, outside the frame: this Land and its origin, the Character, the recipient's full address, the amount, the memo, the fee and the total.
- Only after the Player approves does it sign the transfer and send it to its Node. It answers with the transaction id (64 hex digits), never the signed bytes. A `txId` means the transfer was sent, not that a Block holds it; the Land learns that from the chain. If the Node does not answer, the Shell still returns the `txId`, since it may have the transfer.
- `failed`: the payment cannot be made (no or not enough Gold, a Node on another network or out of reach), which counts as a refusal; or the Node refused the signed transfer after the Player approved, which does not.
- `pay` and `signMessage` share the limits above: one request open at a time, `busy` for 10 seconds after a refusal, `blocked` after 3.

## The Shell's signing and payment prompts

- The prompt is the only trusted surface, so the Shell builds it from its own data.
- It covers the whole page. While it is open, the Land's frame is `inert` and ignores pointer events. One prompt is open at a time for the whole Shell.
- The lines the Shell writes (the Land, its origin, the Character) sit above a separate, labelled box holding the Land's text. In that box, control, bidi and invisible characters appear as visible escapes. A payment's memo appears with the same escapes.
- The approve button is not focused. It reacts only to a pointer click, and only one second after the prompt opens.
