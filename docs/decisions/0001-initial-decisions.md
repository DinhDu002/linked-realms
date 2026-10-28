# 0001 — Initial decisions

Status: accepted, 2026-10-29

The project owner confirmed PLAN.md section 10 on 2026-10-29 after a design review. This record keeps each choice with its reason; PLAN.md section 10 remains the live table.

| # | Decision | Why |
|---|---|---|
| D1 | Phaser 4 in the browser | The original default was Phaser 3; Phaser 4 is the current major version, so starting there avoids a migration. |
| D2 | Colyseus 0.18 | Authoritative rooms, one room per land. The client SDK is `@colyseus/sdk`. |
| D3 | Base Sepolia | Default testnet (P7: testnet only). |
| D4 | `hub-api`: TypeScript (Hono or Fastify) + viem, in `packages/hub-api`. `relay`: Node.js + `ws`, scaled per PLAN.md section 3.5 | ERC-4337 smart wallets (D5) need ERC-1271/6492 signature checks, which viem documents and no maintained PHP library offers. Long-lived connections land on the relay, not on `hub-api`. Cloudflare Tunnel, libp2p and WebRTC were rejected for cost, terms of service or missing Colyseus support. Evidence: `docs/research/2026-10-29-connection-scaling.md`. |
| D5 | Embedded wallet | Open; to be chosen before Phase 2. |
| D6 | MIT | P1 and P3 stop cheating at the contract layer, so AGPL's obligation to publish modified servers adds no protection; MIT is easier for contributors. |
| D7 | `linked-realms` | Working name. |
| D8 | `keccak256` | Native EVM opcode, the cheapest hash to verify on-chain. |
| D9 | 60-second rounds, 50 `GOLD` per round, halving every 210,000 rounds, 21 million cap; initial target calibrated in step 1B | Bitcoin-like schedule. At 60-second rounds a halving takes about 146 days; revisit with testnet data in Phase 3. |
| D10 | Mining runs inside the map server | A browser miner would be much slower. |

Also decided:

- All mines take part in one shared mining competition: one winner per round across the whole world.
- Target scale: about 1,000 concurrent players for testnet and Phase 2; the protocol must reach 100,000+ without a rewrite (PLAN.md section 3.5).
- Node.js 26, the current LTS line since 2026-10-28.
- The repo is public from day one, so `CONTRIBUTING.md`, secret scanning and branch protection moved into Phase 0.
- All repository content is in English.

## Phase 0 tooling

- TypeScript 6.0, not 7.0: typescript-eslint 8.72.1 declares `typescript >=4.8.4 <6.1.0`. Move to 7 once typescript-eslint supports it.
- Internal packages export their TypeScript sources directly (`erasableSyntaxOnly`) with no build step, because Node.js 26 strips types natively.
- Solidity dependencies come from npm through pnpm (`@openzeppelin/contracts` and `@openzeppelin/contracts-upgradeable` 5.6.1, `forge-std` from its v1.17.0 GitHub tag) instead of git submodules: one install command, versions pinned in the lockfile.
- `evm_version = "cancun"`, which Base Sepolia supports; raise it only when a newer opcode is needed.
- Foundry 1.8.6, pinned in CI and in the `anvil` image.
- Slither compiles tests too (`foundry_compile_all`) and filters results from `test/` and `node_modules/`, so it already runs while `src/` is empty.
