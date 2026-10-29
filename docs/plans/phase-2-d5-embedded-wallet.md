# Phase 2 — Embedded wallet and paymaster (D5)

Status: built, 2026-10-29; waiting for the project owner (CDP account, Base Sepolia deployment, spike; bot check service). The project owner chose option F of ADR 0005 and waived the per-step approval gate for this run (PLAN.md section 11); this file is the plan of record.

**Goal** (PLAN.md Phase 2, D5): a new Player needs neither a wallet extension nor gas. The paymaster sponsors only game transactions, with rate limits.

## The owner's answers (2026-10-29)

| Question (ADR 0005) | Answer |
|---|---|
| Option | F: a Coinbase Smart Wallet account through viem with a passkey owner; the CDP Paymaster is called only from `hub-api` |
| Recovery | None. A Player who loses their passkey and has no second owner loses their Land and `GOLD` (as ADR 0002). The client tells the Player to add a backup owner |
| Limits | Each identity (a passkey account that passed the Hub's checks) gets 1 sponsored Character and at most 20 sponsored game transactions per day; plus one global daily cap |
| Base Sepolia | The owner deploys it, as before |

## Work items

### 1. Record the decision

ADR 0005 becomes accepted, with the answers above. PLAN.md: D5 row confirmed; the Phase 2 D5 item points here.

### 2. Sponsorship rule (`packages/shared/src/rules/sponsorship.ts`)

One list, used by `hub-api` and copied into the CDP Paymaster's own configuration (P8):

- Sponsored calls, by contract and function signature: `PlayerRegistry.createCharacter()`, `Land.setDesignHash(uint256,bytes32)`, and `addOwnerPublicKey(bytes32,bytes32)` on the Player's own wallet (a Backup passkey). `GoldToken.transfer` waits until the client sends `GOLD`.
- 20 Sponsored transactions per Player per UTC day; 10,000 per day for the whole world.

### 3. Hub gate (`hub-api`, `POST /aa`)

The CDP endpoint serves both the bundler and the paymaster, and its URL holds the API key, so the client never sees it. `POST /aa` is a JSON-RPC proxy for a signed-in Player only:

- Only the ERC-4337 bundler methods the client needs and the ERC-7677 paymaster methods are forwarded; anything else is refused.
- Every user operation in a request must: use EntryPoint v0.6; be sent from the signed-in Player's own account; deploy (if at all) through the Coinbase Smart Wallet factory; contain only allowlisted calls with no ETH value. A `createCharacter()` call is refused when the Player already has a Character, so a reverting operation is never paid for.
- Caps are counted in PostgreSQL when the paymaster signs (`pm_getPaymasterData`, or a stub the paymaster marks final), per Player and globally, so a restart does not reset them.
- `HUB_BUNDLER_URL` (secret, server only) turns the route on; without it `/aa` answers 503.

### 4. Passkey wallet in the client

- A third wallet kind, the Passkey wallet, offered on every chain except local anvil (the account contracts exist on Base Sepolia): "Create passkey wallet" and "Sign in with passkey". The passkey is bound to the client's own domain.
- A new device knows the credential but not its public key. It asks for two signatures and recovers the P-256 public key from them, so no server stores passkeys (no Hub record, nothing to trust or migrate). The credential is then kept in `localStorage`.
- Sign-in to the Hub: SIWE signed by the smart account (ERC-6492 before deployment); the Hub already verifies with the public client's action.
- `createCharacter()` from a passkey account goes through `${VITE_HUB_URL}/aa` as a sponsored user operation; the first one also deploys the account.
- After the Character exists, the client reminds the Player that a lost passkey means a lost Land and offers "Add backup passkey" (another device or a security key, added with `addOwnerPublicKey`). The Backup passkey's WebAuthn user id is the wallet's address, so it can find the wallet on its own; an address owner would need a second sign-in path.

### 5. Verification

- Unit tests: the allowlist decoder, every gate refusal, cap counting across the global and per-Player limits, the passkey key recovery.
- Browser check on an anvil fork of Base Sepolia (real factory and EntryPoint, contracts deployed to the fork, nothing sent to Base Sepolia): create a passkey account with a virtual authenticator, sign in to the Hub, then sign in again with cleared storage and get the same address.
- Not possible here: a sponsored `createCharacter()` end to end. It needs the CDP key and the contracts on Base Sepolia (the owner's), so it is the ADR's spike, written as a checklist in `docs/runbooks/base-sepolia.md`.

## Not built

- The bot check on `createCharacter()` (ADR 0005 proposal): it needs a service the owner chooses (for example Cloudflare Turnstile). Until then the world-wide daily cap bounds wallet farming, and sponsorship is free on Base Sepolia.

## Needs the project owner

- A CDP account, a Paymaster on Base Sepolia with the allowlist and limits above, and its endpoint set as `HUB_BUNDLER_URL` on the Hub's server (runbook section 7).
- The choice of a bot check service, if one is wanted before outsiders join.
- The Base Sepolia deployment (runbook), then the spike.
