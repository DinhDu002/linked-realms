# 0005 — Embedded wallet and paymaster

Status: proposed, 2026-10-29 — waiting for the project owner's choice

> This is a proposal. Nothing here is decided. It closes PLAN.md decision D5 only after the project owner accepts or changes it. Evidence, prices, sources and the list of unverified claims: `docs/research/2026-10-29-embedded-wallet.md`.

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

## Proposed decision

1. **Account (F):** use viem `toCoinbaseSmartAccount` with a WebAuthn passkey as owner, relying party set to the company's client domain. The Player can add a second owner as a recovery path.
2. **Paymaster:** use the CDP Paymaster on Base Sepolia with a contract and function allowlist, per-user and global caps. It is called only from `hub-api`, never from the browser. Pimlico is the documented swap-in; changing it must not change the account address.
3. **Hub gate:** `hub-api` signs or forwards a sponsorship request only for an authenticated Player, only for `PlayerRegistry.createCharacter`, `Land.setDesignHash` and (later) `GoldToken.transfer`, and with a per-identity daily cap. `createCharacter` also gets a bot check.
4. **Verification:** `hub-api` verifies SIWE and EIP-712 signatures with viem's public-client `verifyMessage` and `verifyTypedData` actions.
5. **Not sponsored:** Mining Solutions.
6. **Spike before acceptance:** one time-boxed run on Base Sepolia must show that (a) a passkey on our domain creates an account and a sponsored `createCharacter()` succeeds without ETH, (b) a non-allowlisted call is rejected, (c) the Hub verifies SIWE and EIP-712 from that account before and after deployment, (d) a second device finds the same address. If (a) or (d) fails, fall back to option B and re-open this ADR.
7. **Mainnet:** this ADR covers testnet only. Mainnet needs its own written decision and a legal read of the paymaster and wallet vendor terms (PLAN.md Phase 3).

Runner-up: B (thirdweb in-app wallets), if the owner wants email or social login and accepts vendor-held key shares. Its custody, allowlist, per-user cap and Base Sepolia facts still need a primary-source check.

## Consequences

If the proposal is accepted:

- Login is passkey only in Phase 2. Players without a passkey-capable browser or device cannot sign in until another owner type is supported.
- A Player who loses their passkey and has no second owner loses their Land and GOLD; this extends ADR 0002's "no recovery path". Recovery UX is ours to build.
- `hub-api` stores, for each Player, the passkey public key and account address, so a new device can find the account. This is a lookup record, not custody.
- The Hub is on the critical path for sponsorship (gate, rate limits, paymaster proxy), so a Hub outage stops new Characters but not play.
- The Coinbase Smart Wallet contract targets EntryPoint v0.6 and viem warns that version bumps contain breaking changes; a later account migration is an expected cost.
- Phase 1A's EIP-191 entry check cannot verify a smart account with `ecrecover`; the Hub-signed Travel ticket (Phase 1C) is the path that works, with the Hub doing the ERC-1271/6492 check.
- `packages/shared` gains the sponsorship allowlist (contract, function, daily caps) as a rule, so the Hub and the CDP configuration come from one source (P9).
- New `.env.example` entries: CDP paymaster endpoint and key (server only).

If the owner chooses another option, only items 1 and 2 change; items 3 to 7 hold for every option.

## Questions for the project owner

1. Is passkey-only login acceptable for Phase 2, or are email or social logins required?
2. May a Player lose their Land when they lose their device, or must the product provide recovery, and who may take part in it?
3. Is a vendor holding one key share acceptable under P2?
4. Is a monthly vendor fee in the hundreds of dollars at 10,000 MAU acceptable in exchange for less engineering?
5. How many new Characters per person per day, and what identity proof may the Hub require?
6. Is a CDP account with Coinbase an acceptable vendor relationship?
