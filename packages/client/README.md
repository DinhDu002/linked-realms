# @linked-realms/client

Browser client: Phaser 4 + Vite. Connects a wallet, creates the Character, shows its stats and Land coordinates, signs in to the Hub (SIWE), lists the Directory, enters a Land through the relay with a Travel ticket, walks through Gates into neighbouring Lands, and walks around with the arrow keys or WASD.

```bash
pnpm --filter @linked-realms/client dev   # http://localhost:5181
pnpm --filter @linked-realms/client test
pnpm --filter @linked-realms/client build
```

Configuration is read from Vite env; see `.env.example`.

- Wallets: an injected EIP-1193 wallet; on every chain except 31337 a Passkey wallet (ADR 0005); on chain 31337 only a dev wallet (a random key kept in `localStorage`, topped up through `anvil_setBalance`). The panel always names the wallet in use. No key leaves the browser or the authenticator (P2).
- Passkey wallet: a Coinbase Smart Wallet v1.1 owned by a passkey on the client's domain. Its transactions are user operations sent to the Hub's `POST /aa`, which sponsors game calls only. On a device that has not seen the passkey before, "Sign in with passkey" asks for two signatures and recovers the public key from them (`passkey.ts`); the credential is then kept in `localStorage`. "Add backup passkey" adds a second passkey as an owner, with the wallet's address as its WebAuthn user id so it can find the wallet on its own. There is no other recovery.
- Maps are data (P6): the map text from the Map server goes through `parseLandMap`, and the ground and Mine are drawn from textures generated in code. Nothing is loaded from a URL the server provides.
- Pure modules (`config`, `format`, `gate`, `hub`, `input`, `interpolate`, `passkey`, `tiles`) have Vitest tests; `scene.ts`, `main.ts` and `wallet.ts` are thin Phaser/DOM/wallet glue.
