# @linked-realms/shell

The Shell: the page where a Player keeps their Character's key and enters Lands. It is a static Vite + TypeScript site, with no framework. Everything a Land can ask of it goes through the API in `docs/protocols/shell-land-ui.md`; keys, signatures and addresses come from `@linked-realms/core` (the WebAssembly build of `crates/core`), and statements from `@linked-realms/shared/identity`. Design: `docs/plans/phase-2b-world-without-chain.md`.

- **`setup.html`** creates a Character (24 words to write down, three of them confirmed, a password) or restores one from its 24 words. It is the only page that asks for the words and it never loads a Land.
- **`index.html`** unlocks the Character, shows its address and name, lists the Directory with "Enter", registers a Map server ("Your Land"), and holds the Land's frame, Report and Lock.

## Run

```bash
cp .env.example .env              # optional
pnpm --filter @linked-realms/core build   # once; needs Rust and wasm-bindgen-cli
pnpm --filter @linked-realms/shell dev    # http://localhost:5182
pnpm --filter @linked-realms/shell build  # dist/
```

WebCrypto and WebAssembly need a secure context: `localhost` in development, HTTPS in production.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITE_HUB_URL` | `http://localhost:8787` | The Hub's URL, fixed when the Shell is built. Statements name its host (`localhost:8787`, or `hub.example.org` for an `https` URL on port 443), so it must equal the Hub's `HUB_DOMAIN`. The Hub also needs this Shell's origin in `HUB_ALLOWED_ORIGINS`. |

## Security model

- **Keys stay here.** Setup draws 32 random bytes, shows them as 24 words, and stores them encrypted in IndexedDB in this origin: `{ version, address, kdf: { alg: "argon2id", m: 65536, t: 3, p: 1, salt }, iv, ciphertext }`. The key is Argon2id (`hash-wasm`) over the password, the cipher is AES-GCM through WebCrypto with a fresh IV, and the address is the additional data. The parameters live in the record, so they can be raised later.
- **Lock.** After 15 minutes without input on the Shell's own page, or when the Player chooses Lock, the Shell frees the key (in WebAssembly memory), zeroes the decrypted bytes and drops the Hub session token. The Land keeps running; its next travel or signature opens the Shell's own unlock modal, and cancelling answers `locked`. The session token lives in memory only; unlocking signs in to the Hub again.
- **The frame.** `<iframe sandbox="allow-scripts allow-same-origin allow-pointer-lock" allow="" referrerpolicy="no-referrer">`, with `src` taken only from the Directory's `url`, in a grid row under the bar so it cannot cover it. The bar shows the Land's name, its origin and "The Shell never asks for your 24 words outside Setup."
- **Connecting.** On every `load` the Shell gets a fresh Travel ticket, signs the arrival statement, and posts `linked-realms/connect` to the Land's exact origin with one end of a new `MessageChannel`, then `init`. A Land that reloads faster than every 5 seconds is stopped. The Shell listens to nothing on `window`, only to that port, so messages from other windows or origins are ignored.
- **The port.** `src/portHandler.ts` drops messages over 64 KiB and ignores unknown types. `travel` is limited to one a second and one at a time. `signMessage` takes one request at a time, answers `busy` for 10 seconds after a refusal and `blocked` after 3 refusals since the frame loaded; a cancelled unlock counts as a refusal, and while those limits hold the Shell does not ask for the password on the Land's behalf. One signing prompt is open at a time for the whole Shell, and a reload or Leave closes it as a refusal. The Shell builds the `Land message` statement itself. `pay` is `unsupported`.
- **The signing prompt.** A modal `<dialog>` in the Shell's document with the frame `inert`. The Land, its origin and the Character are the Shell's own lines; the Land's text is in a separate labelled box, with control, bidi, invisible, unusual-space and unassigned characters (and `\`) shown as escapes (`src/escape.ts`). Approve is not focused and answers only a trusted pointer click, and only one second after the prompt opened. Deny, Escape or closing answers `denied`.
- **Headers.** The `shell` image (`docker build --target shell .`) serves `dist/` with Caddy, sending the headers of `src/headers.ts` written out by `scripts/caddy-headers.ts`. `vite.config.ts` sets the same ones for `vite` and `vite preview` (`src/headers.ts`): a CSP with `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'` and the Hub's origin, `frame-src https: http://*.localhost:*`, `frame-ancestors 'none'`, and `Cross-Origin-Opener-Policy: same-origin`. The dev server also allows injected styles and its WebSocket.

## Tests

- `pnpm --filter @linked-realms/shell test`: Vitest, no browser. The key store (round trip, wrong password, address binding), the vault (lock wipes the key, the entropy and the token; the idle timer), the Hub client (never answered from the browser's cache, because the Directory's `stale-while-revalidate` is meant for shared caches), sign-in, handoff, the port handler's checks and limits, travel planning, the prompt's escaping, the headers.
- `pnpm --filter @linked-realms/shell test:browser`: Playwright in `e2e/`, Chromium and Firefox. The first run needs `pnpm --filter @linked-realms/shell exec playwright install chromium firefox`. It builds the Shell against a stub Hub (`e2e/hub-stub.ts`, which checks every signed statement and signs real Travel tickets with a development key) and serves a hostile Land on `1.localhost` and `2.localhost` (`e2e/land-server.ts`), on both loopbacks because macOS resolves `*.localhost` to `::1` only. The tests cover Setup and unlocking, the frame's isolation (it cannot read `parent.document`, the Shell's IndexedDB or the session token), the signing prompt (nothing returned before a click, Deny, Enter and Space do not approve, escaped text, clicks on the frame do nothing), the frame never covering the bar, messages from other windows being ignored, `pay`, the rate limits, travel with `from`, a travel that the Player leaves before its ticket arrives, a reload closing the open prompt, a double click on Create, locking, Report, registering a Map server and setting the Land's own domain. Fixed ports: 4182 (Shell), 8791 (Hub stub), 8792 (Lands).
- `pnpm e2e:world` (from the repository root): Playwright in `e2e-world/`, Chromium, against the real world in `compose.yaml` (README: Run the world). Both development Characters restore their 24 words and register their Map servers, one walks from Land 1 through the east Gate into Land 2 and back, and stopping `map-1` shows Land 1 offline in the Directory until it starts again. It runs again on a world that is already registered.

## Known limits

- The password string and the browser's own copies of what was typed or decrypted cannot be wiped from JavaScript.
- Argon2id runs on the page's thread: unlocking may pause the page for about a second.
- Input inside a Land's frame never reaches the Shell, so a Player who only plays is locked out at the 15-minute mark and is asked for the password at the next travel or signature.
- Safari may delete script-written storage, IndexedDB included, for a site the Player has not interacted with in 7 days (WebKit's Intelligent Tracking Prevention; see <https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/>, not tested here). The 24 words are the backup.
