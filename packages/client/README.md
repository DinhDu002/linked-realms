# @linked-realms/client

Browser client: Phaser 4 + Vite. Connects a wallet, creates the Character, shows its stats and Land coordinates, enters the Land through the Map server, and walks around with the arrow keys or WASD.

```bash
pnpm --filter @linked-realms/client dev   # http://localhost:5181
pnpm --filter @linked-realms/client test
pnpm --filter @linked-realms/client build
```

Configuration is read from Vite env; see `.env.example`.

- Wallets: an injected EIP-1193 wallet, or on chain 31337 only a dev wallet (a random key kept in `localStorage`, topped up through `anvil_setBalance`). The panel always names the wallet in use. No key leaves the browser (P2).
- Maps are data (P6): the map text from the Map server goes through `parseLandMap`, and the ground and Mine are drawn from textures generated in code. Nothing is loaded from a URL the server provides.
- Pure modules (`config`, `format`, `input`, `interpolate`, `tiles`) have Vitest tests; `scene.ts`, `main.ts` and `wallet.ts` are thin Phaser/DOM/wallet glue.
