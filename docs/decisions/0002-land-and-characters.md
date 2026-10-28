# 0002 — Land and characters

Status: accepted, 2026-10-29

## Context

Phase 1A adds the `PlayerRegistry` and `Land` contracts. PLAN.md section 5.1 says each wallet creates exactly one Character and one Land, but it left open whether a Land, an ERC-721 token, can change hands, and how the rules in `packages/shared/src/rules` reach the contracts (P9).

## Decisions

1. **A Land is soulbound.** The project owner decided on 2026-10-29 that a Land cannot be transferred: a Land is the world hosted on its owner's own machine, and in later stages its size depends on what the owner invests in that machine. `Land` reverts every transfer and approval with `Soulbound()`. A Character is soulbound too (there is no transfer function).
2. **Creating a Character mints the Land in the same transaction.** `PlayerRegistry.createCharacter()` calls `Land.mint(msg.sender)`; `Land` accepts mints only from the registry, set once with `setRegistry` right after deployment. One transaction gives the Player both, matching "a player creates a character ... receives a land".
3. **Land ids start at 1**, and Land `n` sits at spiral index `n - 1`. Id 0 means "no Land" in `landOf` and `landAt`.
4. **Axes:** `x` grows east, `y` grows south, the same direction as screen and tile coordinates. The spiral starts east of the centre and turns towards +y (PLAN of record: `docs/plans/phase-1a-land-and-characters.md`).
5. **Stat keys** are ASCII strings left-aligned in a `bytes32`, so events and storage stay readable without a lookup table.
6. **Rules reach the contracts through code generation.** `packages/shared/scripts/generate.ts` writes `contracts/src/generated/Rules.sol`, `packages/shared/test-vectors/*.json` and `maps/empty-land.json` from the TypeScript rules; a Vitest test fails when any of them is stale, and `forge test` reads the vectors to check that the contracts compute the same results. The contracts still take their parameters in `initialize`, so values can be tuned without a code change.
7. **ABIs and deployments live in `packages/shared`.** `pnpm --filter @linked-realms/shared export-abi` copies ABIs from `contracts/out`; `contracts/script/Deploy.s.sol` writes `packages/shared/src/deployments/<chainId>.json` and refuses any chain other than anvil (31337) and Base Sepolia (84532) (P7).
8. **The Mine is 2×2 tiles in the middle of the 64×64 Land** (tiles 31–32 on both axes), and only the Mine blocks movement in stage 1.
9. **Phase 1A entry check:** a Player enters a Land by signing a short-lived EIP-191 message naming the Land; the Map server also checks on-chain that the signer has a Character. Phase 1C replaces this with a Travel ticket signed by the Hub.

## Consequences

- A Land owner who loses their wallet loses their Land; there is no recovery path in stage 1.
- `setRegistry` is a one-time owner call; until it runs, no Character can be created.
- Changing a rule means running `pnpm --filter @linked-realms/shared generate` and committing the generated files; CI fails otherwise.
