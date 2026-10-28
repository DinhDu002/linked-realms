# Research brief: embedded wallet and paymaster for linked-realms (decision D5)

**Basis.**
- Question: how can a new Player play without installing a wallet or paying gas (PLAN.md D5, Phase 2), while keeping P1, P2, P7 and the rule "the paymaster only sponsors game transactions, with rate limits"?
- `[id]` is a claim id; the Source index at the end gives the URL and a quote for each. Prefixes: `pv-` Privy, `tw-` thirdweb, `cb-` Coinbase (Smart Wallet / Base Account SDK / CDP), `dy-` Dynamic, `w3-` Web3Auth (now MetaMask Embedded Wallets), `pm-` Pimlico, `al-` Alchemy, `vm-` viem.
- "(inf)" marks my own inference or arithmetic. "UNVERIFIED" marks something I could not confirm from a primary source in this session.
- How the evidence was gathered: pages were read through a summarising fetch tool, so quotes are the ones the tool returned in quotation marks. Several vendor pages returned 403/404 (Privy terms, Coinbase CDP terms) and several facts came only from search-result summaries; those are marked "(search summary)". Third-party price trackers (costbench and similar) contradicted each other and are not used for any number.
- No traffic profile exists. Scale numbers below are arithmetic on stated assumptions, not measurements.

## Summary

- The deciding facts are not the vendor logos but four properties: (1) can the paymaster be restricted to named contracts and functions, (2) who can sign for a Player's address (P2), (3) can the Player keep the same address if we switch vendor, (4) does the SDK work without React.
- Only the Coinbase Developer Platform (CDP) Paymaster documents a native contract and function allowlist plus per-user and global caps, and it is unlimited on Base Sepolia [cb-1][cb-2]. Pimlico and Alchemy give per-user limits but no documented contract/function allowlist; they close the gap with a webhook to our own server [pm-2][al-2]. thirdweb documents a contract allowlist (search summary only). Privy documents no allowlist for its native sponsorship [pv-8].
- Because every option needs an identity-aware gate against wallet-farming (new wallets are free, so per-address limits alone do not stop spam), the Hub API should sit in front of any paymaster whatever we pick (inf).
- Recommendation: a thin self-assembled stack on open standards: viem account abstraction, Coinbase Smart Wallet contract with a passkey owner bound to our own domain, CDP Paymaster (Pimlico as the swap-in) proxied by the Hub API. Runner-up: thirdweb in-app wallets if the owner wants email/social login. Reasons and risks in section 8.
- Main trade-off: the self-assembled stack gives the strongest P2 fit and no wallet-vendor lock-in, but costs engineering time and offers weaker login and recovery (passkey only).

## 1. Requirements taken from the repo

| Need | Source | Consequence for the choice |
|---|---|---|
| No server holds a Player's main key; the Player signs their own transactions | P2 | A vendor that can sign alone (or whose compromise lets an attacker sign) conflicts with P2 in spirit. See section 4. |
| Testnet only; Base Sepolia (84532) | P7, D3 | Vendor must support 84532. Mainnet only after a written decision. |
| Phaser 4 + Vite + viem 2.x, no React | D1, section 4 | React-only SDKs need a React island for login or are out. |
| Hub API verifies SIWE and EIP-712 with viem public-client actions (ERC-1271/6492) | D4 | The account type must be verifiable on-chain by `eth_call` or by viem's 6492/8010 paths. |
| Sponsor only `PlayerRegistry.createCharacter()`, `Land.setDesignHash(...)`, later GOLD transfers; rate-limited | D5, section 9 | Contract + function allowlist and per-user caps, or a server-side gate. |
| Mining Solutions are paid by each Map server's own Mining key | P2, CONTEXT.md | Not sponsored. Nothing here changes that. |
| Land is soulbound; losing the wallet loses the Land (ADR 0002) | ADR 0002 consequences | Recovery model of the wallet is a game-design question, not just a UX one. |
| Repo is MIT and public; the company serves the client | D6 | Vendor API keys cannot ship in the client; paymaster calls must go through the Hub API [cb-3]. |
| Phase 1A entry check is an EIP-191 signature naming the Land, checked by the Map server | ADR 0002 item 9 | A smart-account Player cannot be checked with `ecrecover`. Phase 1C replaces this with a Hub-signed Travel ticket, so the Hub (viem) does the 1271/6492 check, not the player-hosted Map server. |

## 2. Options compared

Option letters: A Privy, B thirdweb, C Coinbase Smart Wallet / Base Account SDK (passkey) + CDP Paymaster, D Dynamic, E Web3Auth (MetaMask Embedded Wallets), F self-assembled. I also list CDP Embedded Wallets (C2) because it is the Coinbase product with email/social login.

### 2.1 Chain, login, framework

| Option | Base Sepolia | Login methods | Framework |
|---|---|---|---|
| A Privy | Yes for gas sponsorship ("App pays" lists Base Sepolia) and 7702 examples [pv-8][pv-7]. | Vanilla core lists email OTP, SMS OTP, OAuth, custom JWT, SIWE [pv-5]. | React SDK is the main one. The vanilla `js-sdk-core` says to contact Privy before using it [pv-5]. In practice React (inf). |
| B thirdweb | Example uses chainId 84532 but the page does not name the network [tw-3]. Support likely, UNVERIFIED. | Social (Google, Apple, Discord, X, Telegram...), email, phone, passkey, guest, SIWE wallet, custom JWT [tw-5]. | TypeScript SDK `thirdweb/wallets/in-app`; the page shows no framework code but does not state framework independence [tw-5]. |
| C Coinbase Smart Wallet / Base Account SDK | Yes via CDP Paymaster ("Base Mainnet and Base Sepolia only") [cb-1]. | Passkey only ("no installs, seed phrases, or network switches") [cb-4]. | Vanilla JS SDK (`@base-org/account`, `createBaseAccountSDK`) [cb-4]. Docs were moved and the SDK renamed "Coinbase Wallet SDK" [cb-9]. |
| C2 CDP Embedded Wallets | Listed as test network [cb-8]. | CDP-managed email, SMS, social, or your own JWT [cb-8]. | TypeScript, React, React Native [cb-8]. |
| D Dynamic | Page does not mention Base Sepolia; supported-chain list not read. UNVERIFIED [dy-2]. | Not read in this session (email, social, passkey likely). UNVERIFIED. | Headless `@dynamic-labs-sdk` with `createDynamicClient` works without React (search summary) [dy-5]. |
| E Web3Auth | Not mentioned [w3-1][w3-3]. UNVERIFIED. | Social/email via the modal; not read in detail. | `@web3auth/modal` plain JS, modal-based; no headless mode found [w3-3]. |
| F self-assembled | Any chain viem and the bundler support; CDP and Pimlico support Base Sepolia [cb-1][pm-1]. | Passkey (WebAuthn) on our domain; other signers can be added (EOA owner) [vm-3]. | viem only. Works with Phaser/Vite. |

### 2.2 Key custody, recovery, who can move assets (P2)

| Option | Custody model | Recovery | Export / exit |
|---|---|---|---|
| A Privy | Key split in two by Shamir sharing; the enclave share is decryptable only inside an AWS Nitro enclave; the auth share is stored by Privy; both are needed to sign [pv-2]. Signing needs an API credential plus an authorization-key signature [pv-2]. Privy calls wallets "non-custodial" [pv-3]. | Not described on the pages read. UNVERIFIED. | Modal export via React `exportWallet` only; programmatic export needs Privy support to enable and works for TEE wallets only [pv-4]. For smart wallets, export covers the signer key, not the smart wallet [pv-4]. |
| B thirdweb | "Designed to be non-custodial and only users can access their full keys" [tw-2]. Storage architecture is on a separate security page not read. UNVERIFIED. | Relies on the recovery of the login method; users can link several auth methods [tw-2]. | Export only through the Connect modal; "not possible ... programmatically" [tw-2]. Commits to run the user service 12 months after a shutdown announcement [tw-2]. |
| C Coinbase Smart Wallet | User-held passkey is the owner; "users hold their own keys" [cb-4]. Wallet is a smart contract with many owners, owners are addresses or passkey public keys (search summary) [cb-6]. | Add another owner (EOA or second passkey) (inf from multi-owner design). Passkey sync is by the platform (iCloud, Google) (inf). | The passkey is scoped to the relying-party domain it was created on (WebAuthn rule, inf). With the Base SDK that is Coinbase's domain, so signing is tied to Coinbase's UI unless another owner was added (inf). |
| C2 CDP Embedded Wallets | Custody described only for API-key wallets (TEE). For user wallets: "Only users can export their keys" [cb-8]. Rest UNVERIFIED. | UNVERIFIED. | User export exists [cb-8]. |
| D Dynamic | End user owns the wallet; user share on device, server share signs inside a TEE; default 2/2 [dy-3]. | "Key shares can be restored through several options" (not detailed) [dy-3]. | End users can always export [dy-3]. Export is on by default and the developer can disable it (search summary). |
| E Web3Auth | 2-of-n shares, typically 3: authentication share (generated by a 5/9 network consensus), device share, backup share [w3-2]. Whether the vendor can reconstruct a key is not stated [w3-2]. | Backup share recovery. Details UNVERIFIED. | Export API not found. UNVERIFIED. MPC TSS appears under Enterprise only [w3-1]. |
| F self-assembled | Passkey in the Player's device or synced platform keychain, our domain as relying party. Nobody else can sign unless the Player adds them as owner. | Only what we build: second owner, recovery owner. Weakest login/recovery UX of the set. | Best. Account is an open contract; add or remove owners on-chain. |

P2 reading (inf): options A, B, D and C2 split a key between the user's credential and vendor infrastructure and rely on the vendor's attestation that it cannot sign alone. That can satisfy P2 ("no server holds the main key") only as far as the vendor claim is true; I could verify the architecture only for Privy [pv-2] and Dynamic [dy-3] (both vendor statements). Passkey-owned accounts (C, F) are unilateral by construction. In all options the Hub and Map servers never hold the key.

### 2.3 Smart account standard and signature verification with viem

| Option | Account type | Verifies with viem on the Hub |
|---|---|---|
| A Privy | Embedded EOA made smart by EIP-7702 delegation (gas sponsorship or direct delegation) [pv-6][pv-8]. Any 7702 implementation may be used (Alchemy, Biconomy, Pimlico, ZeroDev, Porto) [pv-7]. | Yes through ERC-1271, but Privy must sign with `signatureOptions: {type: 'erc1271'}` or raw ECDSA may not match [pv-6]. viem `verifyMessage` also lists "pre-delegated (via ERC-8010)" [vm-1]. |
| B thirdweb | EIP-7702 is the recommended and default mode; ERC-4337 is the alternative, with a different address (search summary) [tw-3]. | Same viem paths (inf). UNVERIFIED with thirdweb specifically. |
| C Coinbase Smart Wallet | ERC-4337 account, EntryPoint v0.6 [cb-6]. | Yes. Base docs: verification through `isValidSignature` (EIP-1271) and "signature support before deployment via ERC-6492" [cb-5]; viem `verifyMessage`/`verifyTypedData` actions handle deployed (1271) and pre-deployed (6492) accounts [vm-1][vm-2]. Note the standalone `verifyTypedData` util "only supports Externally Owned Accounts"; use the public-client action [vm-2]. |
| D Dynamic | Built-in sponsorship uses EIP-7702 delegation, set up automatically on the first sponsored transaction [dy-2]. ZeroDev (ERC-4337) is the alternative (search summary) [dy-5]. | Same as A (inf). UNVERIFIED with Dynamic. |
| E Web3Auth | Signer for any AA SDK; native AA "not Base" per the pricing page (ambiguous) [w3-1]. | Depends on the AA SDK chosen. |
| F self-assembled | viem `toCoinbaseSmartAccount` (owners may be a WebAuthn passkey; "Version bumps DO contain breaking changes") [vm-3], or another viem smart account. | Yes, same as C. |

### 2.4 Paymaster policy controls ("only game transactions, rate-limited")

| Paymaster | Contract / function allowlist | Per-user limit | Global limit | Testnet cost | Notes |
|---|---|---|---|---|---|
| CDP Paymaster | Yes: "contract allowlists", and functions such as `mintTo(address)` [cb-1][cb-2] | Yes, USD or UserOperation count, daily/weekly/monthly reset [cb-2] | Yes [cb-2] | "unlimited on testnet" [cb-2] | Base Mainnet and Base Sepolia only [cb-1]. Mainnet: gas plus a 7% fee [cb-1]. Endpoint URL contains the key, so proxy it through the backend [cb-3]. |
| Pimlico | Chain allowlist only in the policy object; contract allowlist not found [pm-2]. Webhook approves or rejects each sponsorship [pm-1]. | Yes, with reset `never/daily/weekly/monthly` [pm-2] | Yes [pm-2] | "On testnets there is no surcharge" [pm-1] | EntryPoint 0.6, 0.7 and 0.8 supported [pm-4]. Currency USD only [pm-2]. |
| Alchemy Gas Manager | Allowlist is for sender addresses only [al-2]. Webhook for custom rules; `approveOnFailure` approves when the webhook errors or times out, so set it to false [al-2]. | Spend and count per sender [al-2]. Spend limits are lifetime totals, not per day (search summary, support article) [al-3]. | Yes [al-2] | Free tier: gas sponsorship "Testnet only" [al-1] | Mainnet admin fee 8% (page extract, plan column unclear) [al-1]. |
| thirdweb | Contract allowlist, chain limits, server verifier (search summary). Per-user cap not found. UNVERIFIED | UNVERIFIED | Monthly USD cap (search summary) | UNVERIFIED | Surcharge 2.5% on mainnet only [tw-1]. |
| Privy native | No allowlist described [pv-8]. App-side metering via a `sponsor` true/false parameter; the guide's example caps $2 per wallet, $5 per user, $100 per app per day, enforced in our code [pv-9]. | App-built [pv-9] | App-built [pv-9] | UNVERIFIED | Sponsorship is powered by Alchemy (search summary). Billed as network gas plus a convenience fee (amount not stated) [pv-8]. |
| Dynamic | Toggle per network type and chain only; per-user and per-transaction control means "server-controlled sponsorship" where our backend validates and relays (page extract) [dy-2]. | Our backend | Rejected when a paymaster limit is hit (extract) [dy-2] | Testnet sponsorship on every plan; mainnet needs Enterprise (extract) [dy-2] | |

Cross-cutting findings:
- Per-address limits do not bound a wallet-farmer: a new passkey or social login is a new address. The identity used for rate limiting must be something that costs the attacker effort (verified email or OAuth identity, Turnstile, IP and device signals) and must live in the Hub (inf). With passkey-only login the identity is free, so the Hub gate matters more.
- `createCharacter()` mints a soulbound Land in the same transaction (ADR 0002 item 2), so each sponsored `createCharacter()` also extends the spiral of Lands. Capping new characters per identity per day is a game-design control as well as an anti-spam one.
- Every paymaster above can be called via ERC-7677 style endpoints or a webhook, so the paymaster is swappable independently of the wallet (inf, strongest for CDP and Pimlico; not verified for ERC-7677 on all).

## 3. Pricing

Gas on Base Sepolia has no value, so on testnet the cost is the vendor fee only. Figures are list prices from the vendor pages read; none were negotiated.

Assumptions (mine): MAU = Player who signs in at least once a month; each Player causes 5 sponsored operations per month on average (1 `createCharacter` in their first month, then `setDesignHash` and GOLD transfers). Change these and the vendor-usage lines change.

| Option | Testnet / entry | 1,000 MAU | 10,000 MAU | Source |
|---|---|---|---|---|
| A Privy | Developer plan free for 0-499 MAU; at 500 MAU new users cannot sign up | Core tier (500-2,499 MAU): $299 per month | Above 10,000 MAU the page says "$2,000; $0.05 per MAU above 10,000 MAUs; and $0.01 per signature above 50,000 signatures", so about $2,000 per month at the boundary (inf). Includes 50K free signatures per month; sponsored-gas convenience fee unknown | [pv-1] |
| B thirdweb | Growth $99 per month; free-plan existence UNVERIFIED | $99 plan fee; first 1,000 wallets free; sponsored 5,000 ops = 4,000 over the 1,000 included at $1 per thousand, about $4 (inf) | $99 + 9,000 wallets x $0.015 = $135, so about $234 per month; sponsored 50,000 ops about $49 (inf; assumes the rate applies only above the first 1,000 wallets). Mainnet gas surcharge 2.5% | [tw-1] |
| C Coinbase Smart Wallet + CDP Paymaster | Unlimited sponsorship on testnet | No wallet fee documented (UNVERIFIED); paymaster free on testnet | Same. Mainnet: gas + 7%; up to $15K per month sponsorship credit mentioned for mainnet [cb-2] | [cb-1][cb-2] |
| C2 CDP Embedded Wallets | First 5,000 operations per month free, then $0.005 each | If a Player causes 10 billable operations (a send is sign + broadcast = 2 ops, per search summary): 10,000 ops, about $25 (inf) | 100,000 ops, about $475 (inf) | [cb-7] |
| D Dynamic | Free sandbox; going live needs a paid plan | Growth $249 per month up to 5,000 MAU | $249 + 5,000 x $0.005 = about $274 (inf from "additional $0.005 per MAU"; confirm with sales). Mainnet sponsorship needs Enterprise (extract) | [dy-1][dy-2] |
| E Web3Auth | Base plan free for 1,000 MAW; "Devnet" for testing | Free | Growth $69 + 7,000 x $0.045 = about $384; Scale $399 for 10,000 included (inf). MPC TSS listed under Enterprise | [w3-1] |
| F self-assembled | Pimlico testnet no surcharge; CDP unlimited on testnet | No wallet fee (our own code). Pimlico pay-as-you-go: sponsored op about $0.0105 so 5,000 ops about $52 if charged on testnet (UNVERIFIED on testnet) | About $525 under the same assumption. Mainnet adds a 10% gas surcharge on Pimlico, 7% on CDP | [pm-1][cb-1] |

Monthly list price at 10,000 MAU (inf, list): thirdweb about $234, Dynamic about $274, Web3Auth about $384-$399, CDP embedded about $475, Privy about $2,000, self-assembled about $0 plus op fees. Self-assembled has no wallet fee but costs engineering time that the table does not price.

## 4. Lock-in and exit path

| Option | If we switch vendor, does a Player keep the same address and assets? |
|---|---|
| A Privy | Address is an EOA. Keys are exportable by the user through the React modal [pv-4]. Moving the key to another provider means every Player must export it themselves (inf); no bulk path. 7702 delegation can point to another implementation (inf). |
| B thirdweb | Same shape: user export through the modal only, not programmatic [tw-2]; 12-month shutdown commitment [tw-2]. The 4337 mode has a vendor-specific address (search summary). |
| C Coinbase Smart Wallet | The contract is open and deployable permissionlessly (search summary) [cb-6]. Signing UI is Coinbase's popup; exit means adding another owner before leaving (inf). |
| C2 CDP Embedded | User export exists [cb-8]. Bulk migration: UNVERIFIED. |
| D Dynamic | User export on by default [dy-3]. Vendor now part of Fireblocks (Oct 2025) [dy-4]. |
| E Web3Auth | Export API not found. UNVERIFIED. |
| F self-assembled | Best. Account is an open contract; swapping bundler or paymaster is a config change (ERC-4337 is standard); owners are on-chain. The only vendor-specific state is our own Hub record of each passkey public key (inf). |

Why exit matters here: the Land is soulbound to the Land owner's address and GOLD rewards go to that address (ADR 0002, CONTEXT.md). A forced address change is not a migration; it is a loss of the Land (inf).

## 5. Terms of service relevant to games and crypto rewards

- thirdweb: forbids "illegal online gambling / wagering", forbids "any activity that the Company deems, in its sole discretion, may be associated with a high level of risk", and forbids using the software "to create any token that may constitute a security under applicable law"; it may terminate "at any time and without notice" [tw-4]. GOLD is mined, capped and testnet-only today, but this wording matters at Phase 3.
- Privy, Coinbase CDP, Dynamic, Web3Auth, Pimlico, Alchemy: developer terms not read (Privy terms 404, Coinbase terms 403). UNVERIFIED. The Privy Acceptable Use Policy I found covers its marketing platform, not the wallet product (search summary).
- Applies to all: vendor terms can end service at their discretion, so the exit path in section 4 is also the terms-risk mitigation. A legal read of each shortlisted vendor's developer terms belongs in the Phase 3 legal review (PLAN.md section 6), and before mainnet.

## 6. Maturity and maintenance signals

- Privy: Stripe announced the acquisition in June 2025; it is to keep operating as a product (search summary) [pv-10]. SOC 2 Type I and II [pv-3].
- Dynamic: acquired by Fireblocks, announced October 2025 [dy-4]. SOC 2 Type 2 [dy-3].
- Web3Auth: acquired by Consensys, now marketed as MetaMask Embedded Wallets; package names still say Web3Auth [w3-4]. Price changes in 2026 were reported only by trackers I do not trust.
- Coinbase: docs for the Base Account SDK moved to CDP and the SDK is now called Coinbase Wallet SDK [cb-9]. Naming churn is a documentation risk. The Smart Wallet contract targets EntryPoint v0.6, an old version [cb-6]; viem warns version bumps break [vm-3].
- thirdweb: independent; 7702 as default mode suggests active development [tw-3].
- All vendor pages change often; recheck pricing on the day of the owner's decision.

## 7. Risks of each recommendation path

- Sybil/wallet farming against the paymaster: addressed by a Hub gate for every option (section 2.4).
- Passkey public key lookup (F, C): a Coinbase Smart Wallet address is derived from its initial owners (inf). A WebAuthn sign-in does not by itself return the public key, so the Hub must store credential-to-public-key-to-address records, or the Player cannot find the account on a new device (inf, UNVERIFIED; this is the first thing the spike must test).
- Passkey loss without a second owner means loss of the Land and GOLD (ADR 0002 consequence applies in full).
- EntryPoint v0.6 is old; a later migration of the account contract version is a real cost (inf).
- Vendor MPC/TEE custody claims (A, B, D, E) are attestations I cannot audit; a SOC 2 report is not a proof of "cannot sign alone".

## 8. Recommendation

Choose option F, built on option C's open pieces, with D5 recorded as a proposal until the owner decides:

1. Account: viem `toCoinbaseSmartAccount` with a WebAuthn passkey owner, relying party = the company's own client domain; Player can add a second owner (EOA or another passkey) as recovery.
2. Bundler and paymaster: CDP endpoint on Base Sepolia (native contract and function allowlist, per-user and global caps, unlimited on testnet), always called from the Hub API, never from the browser [cb-3]. Pimlico (webhook policy) is the documented swap-in.
3. Hub API gate in front of the paymaster: accept a sponsor request only for the allowlisted functions (`PlayerRegistry.createCharacter`, `Land.setDesignHash`, later `GoldToken.transfer`), only for a signed-in Player, and with a per-identity daily cap plus Turnstile-class bot check on `createCharacter`.
4. Verification: Hub uses viem `publicClient.verifyMessage` / `verifyTypedData` (1271/6492/8010 aware) for SIWE and EIP-712 [vm-1][vm-2].
5. Do not sponsor Mining Solutions; the Mining key keeps paying its own fees.

Why: strongest P2 fit (nobody but the Player can sign), no vendor holds the address, one paymaster policy that matches D5 literally, no React, lowest recurring cost. Runner-up: thirdweb in-app wallets (about $234 per month at 10,000 MAU, TS SDK, email/social login), chosen if the owner wants email/social login and accepts vendor-held key shares; its custody, allowlist and per-user cap facts need a primary-source check first. Dynamic is the second runner-up for the same reason but needs an Enterprise plan for mainnet sponsorship. Privy is the most mature wallet product but the most expensive at scale and React-first, so it fits this repo worst.

Cost of the recommendation: more engineering than a vendor SDK, passkey-only login, and recovery is our UI. Before the decision is final, run a time-boxed spike on Base Sepolia (anvil is not enough, the paymaster is hosted) with pass criteria:
- A passkey on our domain creates an account and the sponsored `createCharacter()` succeeds with no ETH.
- A call to any non-allowlisted function is rejected by the paymaster.
- The Hub verifies a SIWE message and an EIP-712 message from that account with viem, before and after the account is deployed.
- A Player on a second device finds the same address (public key lookup problem, section 7).

## 9. Questions only the project owner can answer

1. Login: is passkey-only acceptable for Phase 2 testers, or must new Players sign in with email or social accounts?
2. Recovery: if a Player loses their device, may they lose their Land and GOLD (as ADR 0002 says for a lost wallet), or must the product offer recovery, and who may take part in it (the company, a trusted contact, another device)?
3. Custody: is a vendor holding one key share in its enclave acceptable under P2, or does P2 require that no third party can ever co-sign?
4. Budget and effort: is a fixed monthly fee in the hundreds of dollars at 10,000 MAU acceptable in exchange for less engineering, or should recurring vendor fees be near zero?
5. Anti-abuse: how many new characters per person per day are acceptable, and what identity proof (email, OAuth, none) may the Hub require before sponsoring `createCharacter()`?
6. Vendor relationship: is a company contract with Coinbase (CDP account, 7% fee on mainnet) acceptable, or should the project avoid a single large-vendor dependency?
7. Mainnet: should the choice be made now only for testnet and re-decided in Phase 3 (legal review of vendor terms), as P7 implies?
8. Should the ERC-4337 account version (EntryPoint v0.6 today) be locked now, accepting a later migration, or should we wait for a newer account contract?

## 10. Not verified (do not rely on)

- thirdweb: custody architecture, per-user sponsorship cap, Base Sepolia support, whether a free plan exists.
- Dynamic and Web3Auth: Base Sepolia support, login-method lists, Web3Auth key export and headless use, exact Dynamic overage mechanics.
- Privy: recovery methods, contract allowlist on native sponsorship, sponsorship convenience-fee amount, terms of service.
- Coinbase: developer terms, wallet-fee for the Base SDK, whether the CDP Paymaster accepts a function selector or the full signature (the guides use the full signature, e.g. `mintTo(address)`), ERC-7677 support on every option.
- All ToS other than thirdweb; any third-party price tracker.
- That `toCoinbaseSmartAccount` plus the CDP Paymaster works end to end for a passkey on our own domain (the spike in section 8).

## Source index

**Privy**
- pv-1: https://www.privy.io/pricing. "$2,000; $0.05 per MAU above 10,000 MAUs; and $0.01 per signature above 50,000 signatures." Tiers Developer 0-499 free, Core 500-2,499 $299, Scale 2,500-9,999 $499 (tool-extracted).
- pv-2: https://docs.privy.io/security/wallet-infrastructure/architecture.md. "No share in isolation provides any information or access to the wallet." / "Enclaves have no persistent storage, no interactive access, and no network connectivity."
- pv-3: https://docs.privy.io/security/overview.md. "Privy wallets are non-custodial and have a fully programmable control model." / "SOC2 Type I and Type II compliant."
- pv-4: https://docs.privy.io/wallets/wallets/export.md (search summary). "When invoked, exportWallet will open a modal where your user can copy the full private key or seed phrase for their embedded wallet." / "Programmatic export is only supported for TEE-based wallets."
- pv-5: https://docs.privy.io/recipes/core-js.md. "`@privy-io/js-sdk-core` is a low-level library. Please do not attempt to use this library without" (text truncated by the tool).
- pv-6: https://docs.privy.io/recipes/evm/erc-1271-signatures.md. "ERC-1271 is a standard interface that allows smart contracts to verify signatures on behalf of an address."
- pv-7: https://docs.privy.io/recipes/react/eip-7702.md. Privy supports "all low level interfaces required by 7702".
- pv-8: https://docs.privy.io/wallets/gas-and-asset-management/gas/overview.md. "App pays" mode uses EIP-7702 with paymasters; Base Sepolia listed; sponsorship covers gas plus a convenience fee (tool paraphrase, no verbatim quote returned).
- pv-9: https://docs.privy.io/recipes/gas-sponsorship-rate-limits.md. "Gas sponsorship allows your app to pay for transaction fees on behalf of users."
- pv-10: https://thepaypers.com/online-mobile-banking/stripe-to-acquire-privy-to-further-scale-web3-capabilities--1274043 (search result, not opened).

**thirdweb**
- tw-1: https://thirdweb.com/pricing. "$0.015 / MAU", "First 1000 wallets free", "$1 / thousand txns", "2.5% (Mainnet)", "$99, / month".
- tw-2: https://portal.thirdweb.com/wallets/faq. "Our system is designed to be non-custodial and only users can access their full keys." / "It's not possible to export a user's private key programmatically."
- tw-3: https://portal.thirdweb.com/transactions/sponsor. "All transactions executed by the user will be sponsored via the thirdweb infrastructure." EIP-7702 labelled recommended and default.
- tw-4: https://thirdweb.com/terms. "illegal online gambling / wagering"; "any activity that the Company deems, in its sole discretion, may be associated with a high level of risk."; "you will not use the Software to create any token that may constitute a security under applicable law."
- tw-5: https://portal.thirdweb.com/typescript/v5/inAppWallet. "Creates an app scoped wallet for users based on various authentication methods."

**Coinbase (Smart Wallet, Base Account SDK, CDP)**
- cb-1: https://docs.cdp.coinbase.com/paymaster/introduction/welcome. "CDP Paymaster currently supports **Base Mainnet** and **Base Sepolia** only." / "You're billed for the sponsored gas plus a 7% fee through your CDP account (monthly invoicing)." / "Configure contract allowlists, per-user limits, and global spend caps."
- cb-2: https://docs.cdp.coinbase.com/paymaster/guides/paymaster-masterclass.md. "$15k monthly on mainnet (unlimited on testnet)." Per-user cap by USD or UserOperation count with daily/weekly/monthly reset; global cap; allowlist with function `mintTo(address)` (tool paraphrase).
- cb-3: https://docs.cdp.coinbase.com/paymaster/reference-troubleshooting/security.md. "Without an allowlist, any transaction to any contract could be sponsored." / "route all Paymaster requests through your backend instead of calling the endpoint directly from the frontend."
- cb-4: https://docs.cdp.coinbase.com/coinbase-wallet/overview. "users hold their own keys and you never touch private data or funds." / "no installs, seed phrases, or network switches".
- cb-5: https://docs.cdp.coinbase.com/coinbase-wallet/guides/sign-and-verify-typed-data.md. "Verification happens through the `isValidSignature` function defined in EIP-1271." / "allowing signature support before deployment via ERC-6492."
- cb-6: https://raw.githubusercontent.com/coinbase/smart-wallet/main/README.md. "can only be called by the `EntryPoint` contract (v0.6)." Owners as bytes (address or passkey) and permissionless deployment from the repo README (search summary).
- cb-7: https://docs.cdp.coinbase.com/embedded-wallets/pricing. "Each wallet operation costs $0.005." / "The first 5,000 wallet operations per month are free."
- cb-8: https://docs.cdp.coinbase.com/embedded-wallets/welcome. "Only users can export their keys" / "Base Sepolia, Ethereum Sepolia, Solana Devnet, and other test networks for development."
- cb-9: https://docs.base.org/base-account/overview/what-is-base-account. "The Base Account SDK and Base MCP documentation has moved from Base docs to Coinbase Developer Platform."

**Dynamic**
- dy-1: https://www.dynamic.xyz/pricing. "additional $0.005 per MAU", "$249/month", "Up to 5,000" (tool-extracted).
- dy-2: https://www.dynamic.xyz/docs/javascript/reference/evm/evm-gas-sponsorship.md. "EIP-7702 delegation" on first sponsored transaction; toggle "Sponsor Network Fees (EVM)"; testnet sponsorship on every plan, mainnet on Enterprise (tool paraphrase).
- dy-3: https://www.dynamic.xyz/docs/wallets/mpc/overview. "no complete private key ever exists in one place or is held by a single party."
- dy-4: https://fintechnews.sg/120596/blockchain/fireblocks-acquires-dynamic/ (search result, not opened). Announced October 2025.
- dy-5: https://www.dynamic.xyz/docs/javascript/reference/zerodev/gas-sponsorship-quickstart (search summary, headless `createDynamicClient`).

**Web3Auth / MetaMask Embedded Wallets**
- w3-1: https://web3auth.io/pricing.html. "Free 1,000 Monthly Active Wallets (MAWs)" / "the app will be charged $90 (=2,000 X $0.045)" / "MPC TSS Support for Web and Mobile" (Enterprise).
- w3-2: https://docs.metamask.io/embedded-wallets/features/mpc.md. "The authentication share is generated by the Embedded Wallets Network using a 5/9 consensus."
- w3-3: https://docs.metamask.io/embedded-wallets/sdk/js/. "Install the Web3Auth Modal SDK using npm or yarn".
- w3-4: https://consensys.io/blog/consensys-acquires-web3auth-to-enhance-metamasks-user-experience-user-safety (search result, not opened).

**Pimlico**
- pm-1: https://www.pimlico.io/pricing. "$0 per month, card required." / "On testnets there is no surcharge" / "Approve or reject each sponsorship request in real time from your own server."
- pm-2: https://docs.pimlico.io/references/platform/api/sponsorship-policies/object. "Limits across all users." / "If `null`, the policy is valid for all chains." / "only `USD` is currently supported."
- pm-3: https://docs.pimlico.io/guides/how-to/sponsorship-policies. "You can put limits to the global amount of sponsorships, the amount of sponsorships per user, and per user operation."
- pm-4: https://docs.pimlico.io/references/paymaster/verifying-paymaster/endpoints. "The EntryPoint 0.7 & 0.8 API expects an `UnpackedUserOperation` instead of a `PackedUserOperation`."

**Alchemy**
- al-1: https://www.alchemy.com/pricing. Free plan gas sponsorship "Testnet only"; "8%" admin fee row (tool extract, plan column unclear).
- al-2: https://www.alchemy.com/docs/wallets/transactions/sponsor-gas/conditional-sponsorship-rules. "cap total spend, spend per sender, and spend per transaction." / "sponsorship is approved when webhook errors or times out."
- al-3: https://support.alchemy.com/articles/1436065162-best-practices-to-limit-gas-manager-spend (search summary only: spend limits are lifetime totals).

**viem**
- vm-1: https://viem.sh/docs/actions/public/verifyMessage. Smart-contract cases "Deployed (via ERC-1271)", "Pre-deployed (via ERC-6492)", "Pre-delegated (via ERC-8010)"; `mode` "Chooses which verification path to try first before falling back."
- vm-2: https://viem.sh/docs/actions/public/verifyTypedData. The action supports smart contract accounts; the standalone util "only supports Externally Owned Accounts."
- vm-3: https://viem.sh/account-abstraction/accounts/smart/toCoinbaseSmartAccount. "You can use a Passkey (WebAuthn) to sign User Operations." / "Version bumps DO contain breaking changes."
