# Phase 1A — Land and characters

Status: done, 2026-10-29. The project owner waived the per-step approval gate for this run (PLAN.md section 11); this file is the plan of record.

**Done when** (PLAN.md section 6): on anvil, a player creates a Character with 4 stats equal to 1, receives a Land and walks around; two clients on the same Land see each other.

## Decisions taken in this step

See `docs/decisions/0002-land-and-characters.md`.

- A Land is soulbound: it cannot be transferred, because a Land is the world hosted on its Land owner's own machine (owner's decision, 2026-10-29). A Character is soulbound too.
- `PlayerRegistry.createCharacter()` creates the Character **and** mints the caller's Land in one transaction. `Land` accepts mints only from `PlayerRegistry`.
- Land ids start at 1. Land `n` takes spiral index `n - 1`.
- World axes: `x` grows east, `y` grows south (the same direction as screen and tile coordinates).
- Stat keys are ASCII strings left-aligned in a `bytes32` (`bytes32("strength")` in Solidity, `stringToHex("strength", { size: 32 })` in viem).
- Rules reach the contracts through code generation (P9): `packages/shared/src/rules` is the source; `contracts/src/generated/Rules.sol` is generated from it, and a test fails when the generated file is stale. Cross-check vectors (`packages/shared/test-vectors/*.json`) are generated from the TypeScript rules and read by `forge test`.

## Spiral

Ring `k >= 1` holds indices `(2k-1)^2 .. (2k+1)^2 - 1`; index 0 is `(0, 0)`. With `t = n - (2k-1)^2`:

| `t` | coordinate |
|---|---|
| `[0, 2k)` | `(k, -k + 1 + t)` |
| `[2k, 4k)` | `(k - 1 - (t - 2k), k)` |
| `[4k, 6k)` | `(-k, k - 1 - (t - 4k))` |
| `[6k, 8k)` | `(-k + 1 + (t - 6k), -k)` |

`k = (isqrt(n) + 1) / 2` (integer division).

## Contracts

All UUPS behind `ERC1967Proxy`, `OwnableUpgradeable` (owner = the project owner's multisig on testnet, the deployer on anvil).

- `PlayerRegistry`
  - `createCharacter() returns (uint256 landId)`: one per wallet; sets every stat key to the initial value; mints the Land.
  - `hasCharacter(address) view returns (bool)`, `statOf(address, bytes32) view returns (uint256)`, `statKeys() view returns (bytes32[])`.
  - Events: `CharacterCreated(address indexed player, uint256 indexed landId)`, `StatChanged(address indexed player, bytes32 indexed key, uint256 value)`.
- `Land` (ERC-721 "linked-realms Land", symbol `LAND`)
  - `mint(address to) returns (uint256 landId)`: only `PlayerRegistry`; one per wallet.
  - `landOf(address) view returns (uint256)` (0 = none), `coordinatesOf(uint256) view returns (int32 x, int32 y)`, `landAt(int32 x, int32 y) view returns (uint256)` (0 = none), `totalLands() view returns (uint256)`.
  - `setDesignHash(uint256 landId, bytes32)`: Land owner only; `designHashOf(uint256) view returns (bytes32)`.
  - Every transfer and approval reverts (`Soulbound()`).
  - Events: ERC-721 `Transfer` (mint only), `LandMinted(uint256 indexed landId, address indexed owner, int32 x, int32 y)`, `DesignHashSet(uint256 indexed landId, bytes32 designHash)`.

Deploy: `contracts/script/Deploy.s.sol` writes `packages/shared/src/deployments/<chainId>.json` (`{ "PlayerRegistry": { "address", "startBlock" }, "Land": { ... } }`). ABIs are exported from `contracts/out` into `packages/shared/src/abi/*.ts` (`as const`).

## Packages

- `packages/shared`: rules (spiral, stat keys, land size), Tiled map validation (P6), ABIs, deployments, the join message format.
- `packages/indexer` (Ponder): `character`, `character_stat` and `land` tables from the events above.
- `packages/map-server` (Colyseus 0.18): one `land` room per process for `LAND_ID`; authoritative movement at 20 Hz inside the 64×64 Land; the Mine tile blocks movement. Joining requires a signed join message (EIP-191, expires within 5 minutes) from a wallet that has a Character; Phase 1C replaces it with a Hub Travel ticket.
- `packages/client` (Phaser 4 + Vite): connect a wallet (browser wallet, or a local-only burner wallet on chain 31337), create the Character, show stats and Land coordinates, enter the Land, walk with arrow keys or WASD, see other Players.
- `maps/empty-land.json`: the 64×64 Tiled map with the Mine object in the centre.

## Verification

1. `forge test` covers section 8: one Character and one Land per wallet, stats initialised to 1, no duplicate coordinates, soulbound transfers, spiral cross-check vectors.
2. `pnpm test` covers rules, map validation, the room (Colyseus testing) and the client's pure modules.
3. Manual run on anvil: deploy, start the map server and two browser clients, create two Characters, both appear on Land 1.
