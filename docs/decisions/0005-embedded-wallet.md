# 0005 — Embedded wallet and paymaster

Status: accepted, 2026-10-29 — option F, by the project owner. Superseded by ADR 0008 on 2026-10-29: the Shell holds Players' keys.

> Proposed earlier the same day; the project owner chose option F and answered the questions that ended the proposal (section "The project owner's answers"). Evidence, prices, sources and the list of unverified claims: `docs/research/2026-10-29-embedded-wallet.md`. Plan of record: `docs/plans/phase-2-d5-embedded-wallet.md`.

## Context

PLAN.md D5 and Phase 2 ask for an embedded wallet plus a paymaster, so a new Player needs neither a wallet extension nor gas. The paymaster may only sponsor game transactions, with rate limits. The chain is Base Sepolia (84532); mainnet needs a separate written decision (P7).

Fixed by the repo:

- The client is Phaser 4 + Vite + viem 2.x with no React.
- The Hub verifies SIWE and EIP-712 signatures with viem's public-client actions (ERC-1271/6492 aware), as D4 recorded.
- Transactions to sponsor: `PlayerRegistry.createCharacter()`, `Land.setDesignHash(...)`, later `GOLD` transfers. Mining Solutions are sent by each Map server's Mining key and are not sponsored.
- P2: no server holds a Player's main key.
- A Land is soulbound and `createCharacter()` mints it (ADR 0002), so the Player's address is permanent: a forced address change loses the Land.
- The repo is public under MIT and the company serves the client, so no vendor key can ship in the client.

## Options

| | Option | Account | Paymaster | Login | Monthly list price at 10,000 MAU* |
|---|---|---|---|---|---|
| A | Privy | Embedded EOA + EIP-7702 | Native sponsorship, no allowlist documented | Email, SMS, OAuth, SIWE | about $2,000 |
| B | thirdweb in-app wallet | EIP-7702 (default) or ERC-4337 | thirdweb, contract allowlist (per-user cap unconfirmed) | Social, email, phone, passkey, SIWE | about $234 |
| C | Coinbase Smart Wallet / Base Account SDK + CDP Paymaster | ERC-4337 (EntryPoint v0.6), passkey owner | CDP: contract and function allowlist, per-user and global caps | Passkey only | none documented; paymaster free on testnet |
| C2 | CDP Embedded Wallets | Not confirmed | CDP | Email, SMS, social | about $475 (assumes 10 operations per Player) |
| D | Dynamic | EIP-7702 (built in) or ERC-4337 via ZeroDev | Testnet on all plans, mainnet Enterprise; per-user control by our backend | Not verified | about $274 |
| E | Web3Auth (MetaMask Embedded Wallets) | Signer only | Any AA provider | Not verified | about $384 to $399 |
| F | Self-assembled: viem + passkey on our own domain + bundler/paymaster (CDP or Pimlico) | ERC-4337 Coinbase Smart Wallet contract via viem | CDP or Pimlico, called only from the Hub API | Passkey (more owners can be added) | none for wallets; sponsored operations about $0.0105 each at Pimlico list price |

*List prices from vendor pages, with the assumptions in the research brief. Not negotiated, not including engineering time.

Findings that drive the choice (details and sources in the research brief):

- Only the CDP Paymaster documents a native contract and function allowlist with per-user and global caps, and it is unlimited on Base Sepolia. Pimlico and Alchemy cover per-user limits but need a webhook to our server for function-level rules.
- Per-address limits do not stop wallet-farming, because new wallets are free. Rate limits must be tied to an identity checked by the Hub, whichever option wins.
- A, B, D and C2 split the key between the Player's login and the vendor's infrastructure; P2 holds only as far as the vendor's statement does. C and F are unilateral: only the Player's passkey (and any owner they add) can sign.
- Exit: A, B, D export keys one Player at a time through a vendor UI. F and C keep the same address because the account contract is open and owners are on-chain.
- React-only: Privy's vanilla SDK is marked low-level and not for general use. thirdweb, Dynamic (headless), the Coinbase SDK and viem work without React.
- Terms of service were verified only for thirdweb (gambling, high-risk and token clauses, termination without notice). The rest are unverified.

## Decision

1. **Wallet (F):** a Passkey wallet is a Coinbase Smart Wallet v1.1 account built with viem's `toCoinbaseSmartAccount`, owned by a WebAuthn passkey whose relying party is the client's own domain. The client offers it on every chain except local anvil (the account factory and EntryPoint v0.6 exist on Base Sepolia). The browser wallet stays available; the dev wallet stays anvil-only.
2. **Paymaster:** the CDP endpoint (bundler and paymaster in one URL that holds the API key) is called only by `hub-api`, as `HUB_BUNDLER_URL`. The client sends its user operations to `POST /aa` on the Hub, a JSON-RPC proxy for a signed-in Player. Pimlico stays the documented swap-in; changing it does not change any wallet's address.
3. **Hub gate:** `hub-api` forwards only the ERC-4337 and ERC-7677 methods the client uses. Each user operation must use EntryPoint v0.6, come from the signed-in Player's own wallet, deploy (if at all) through the v1.1 factory, carry no ETH value, and contain only the calls in `SPONSORED_CALLS` (`packages/shared/src/rules/sponsorship.ts`): `PlayerRegistry.createCharacter()`, `Land.setDesignHash(uint256,bytes32)`, and `addOwnerPublicKey(bytes32,bytes32)` on the Player's own wallet (a Backup passkey). `createCharacter()` is refused when the Player already has a Character, so a reverting transaction is never paid for. `GoldToken.transfer` joins the list when the client sends `GOLD`.
4. **Limits:** 20 Sponsored transactions per Player per UTC day and 10,000 per day for the whole world, counted in PostgreSQL when the paymaster signs (`pm_getPaymasterData`, or a stub the paymaster marks final), so a restart does not reset them. The CDP Paymaster is configured with the same limits as a second line.
5. **No passkey store:** WebAuthn returns a passkey's public key only when it is created. A device that sees a synced passkey for the first time asks for two signatures and recovers the P-256 public key from them, so no server stores passkeys and nothing vendor- or Hub-specific is needed to find a wallet. A Backup passkey's WebAuthn user id is its wallet's address, so signing in with it finds the wallet too.
6. **No recovery:** a Player who loses every passkey of their wallet loses the wallet, its Land and its `GOLD` (as ADR 0002). Until the wallet has a second owner, the client says so and offers "Add backup passkey".
7. **Verification:** `hub-api` verifies SIWE and EIP-712 signatures with the public client's `verifySiweMessage` and `verifyTypedData`, which accept ERC-6492 (before the wallet is deployed) and ERC-1271.
8. **Not sponsored:** Mining Solutions (sent by each Map server's Mining key).
9. **Mainnet:** this ADR covers testnet only. Mainnet needs its own written decision and a legal read of the paymaster terms (PLAN.md Phase 3).

## The project owner's answers (2026-10-29)

| Question | Answer |
|---|---|
| Option | F: passkey wallet through viem, CDP Paymaster called only from `hub-api` |
| Passkey-only login in Phase 2 | Yes (option F) |
| Recovery when a device is lost | None: lost means lost; the client reminds the Player to add a second passkey or owner |
| Vendor-held key shares | Not needed: option F keeps P2 without one |
| Sponsorship per identity | 1 Character and at most 20 game transactions per day, plus one world-wide cap |
| Base Sepolia deployment | The owner deploys it (`docs/runbooks/base-sepolia.md`) |

## Changes from the proposal

- The Hub does not store passkey public keys (proposal: "hub-api stores, for each Player, the passkey public key"). Key recovery from two signatures replaces it; the cost is two extra passkey prompts the first time a device is used.
- The second owner is a Backup passkey, sponsored like a game call, because passkey-only login needs a passkey to sign in with. Adding an address owner would need a second sign-in path.
- The bot check on `createCharacter()` is not built: it needs a choice of service (for example Cloudflare Turnstile) that the owner has not made. Until then the world-wide daily cap bounds what wallet farming can spend; on Base Sepolia sponsorship is free.

## Consequences

- Login is passkey-only for new Players. Players without a passkey-capable browser can still use a browser wallet, with their own gas.
- `hub-api` is on the path of every Sponsored transaction (gate, limits, proxy); a Hub outage stops new Characters but not play.
- CDP's contract allowlist names contracts by address, so it cannot name "the Player's own wallet". If CDP refuses the Backup passkey call, its allowlist is switched off and the Hub's list (the only route to the key) is the allowlist; CDP keeps its per-user and global caps. This is one of the spike checks.
- The Coinbase Smart Wallet targets EntryPoint v0.6, and viem warns that version bumps break; a later wallet migration is an expected cost.
- Phase 1A's EIP-191 entry check cannot verify a smart-contract wallet with `ecrecover`; the Hub-signed Travel ticket (Phase 1C) is the path that works.

## Verified, and still to verify

Verified on 2026-10-29 on an anvil fork of Base Sepolia (the real v1.1 factory and EntryPoint, the game contracts deployed to the fork, nothing sent to Base Sepolia), with Chromium's virtual authenticator, `hub-api` and a stand-in bundler that submits `handleOps` itself and pays from the wallet: a Passkey wallet signs in to the Hub before it is deployed (ERC-6492); its first Sponsored transaction deploys it and creates the Character; it signs a Delegation the Hub accepts (ERC-1271); it adds a Backup passkey; with storage cleared, each passkey on its own finds the same wallet and signs in.

The spike that remains needs the owner's CDP account and the Base Sepolia deployment (runbook section 7): the real paymaster pays for `createCharacter()` from a wallet with no ETH; a non-allowlisted call is refused by the Hub and by CDP; the Backup passkey call is sponsored (see Consequences). If the paymaster cannot sponsor the first transaction, re-open this ADR with option B.
