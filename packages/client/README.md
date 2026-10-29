# @linked-realms/client

The reference Land UI: Phaser 4 + Vite. A Land's Map server serves the built `dist/` from the Land's own origin, and the Shell loads it inside its frame. It shows the Land's map and every Character on it, and walks the Player's Character with the arrow keys or WASD.

```bash
pnpm --filter @linked-realms/client dev   # http://localhost:5181, /play proxied to ws://127.0.0.1:2567
pnpm --filter @linked-realms/client test
pnpm --filter @linked-realms/client build
```

- **Shell** (`shell.ts`, `docs/protocols/shell-land-ui.md`): accepts the Shell's `linked-realms/connect` message (only from `window.parent`, api 1, first one only), keeps its port, receives `init` (Land, Character, handoff), sends `travel` when the Character steps onto a Gate, and shows `travelRefused` in plain words. Opened outside a frame, the page says "Open this Land from the Shell" and does nothing else. This page never asks for a password or 24 words, and holds no key.
- **Connection** (`connection.ts`): one WebSocket to `/play` on the page's own origin (wss on https), binary Protocol Buffers (`@linked-realms/shared/land-protocol`). The first message is `hello` with the handoff. An `error` from the Map server is shown in plain words and the socket then closes.
- **Scene** (`scene.ts`): takes decoded `ServerMessage`s (`welcome`, `joined`, `left`, `moved`, `notice`) and sends `input` (dx, dy, growing seq) when the keys change. Each Character is labelled with its name (or its short address), `[AI]` when it is driven by an AI, and a star for the Land's owner.
- Map servers are untrusted (P1) and maps are data (P6): the map text goes through `parseLandMap`, Characters through `readCharacter`, and the ground and Mine are drawn from textures generated in code. Nothing is loaded from a URL the server provides.
- Pure modules (`connection`, `gate`, `input`, `interpolate`, `players`, `shell`, `tiles`) have Vitest tests; `scene.ts` and `main.ts` are thin Phaser/DOM glue. The client does no movement prediction, so it ignores the `seq` in `moved`.
