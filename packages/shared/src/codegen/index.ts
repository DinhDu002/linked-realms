// Renders the artefacts that carry the TypeScript rules into the contracts (P9):
// contracts/src/generated/Rules.sol and the cross-check vectors read by `forge test`.
import { MINE_TILES, TILE_SIZE_PX } from "../map/index.ts";
import { keccak256, toHex, type Address } from "viem";
import * as rules from "../rules/index.ts";

const repoRoot = new URL("../../../../", import.meta.url);

export const outputs = {
  rulesSol: new URL("contracts/src/generated/Rules.sol", repoRoot),
  spiralVectors: new URL("packages/shared/test-vectors/spiral.json", repoRoot),
  emptyLand: new URL("maps/empty-land.json", repoRoot),
  miningVectors: new URL("packages/shared/test-vectors/mining.json", repoRoot),
} as const;

/** Writes round numbers in scientific notation (50e18), which Solidity accepts and reviewers can read. */
function solidityNumber(value: bigint): string {
  const digits = value.toString();
  const zeros = digits.length - digits.replace(/0+$/, "").length;
  return zeros >= 6 ? `${digits.slice(0, -zeros)}e${zeros}` : digits;
}

export function renderRulesSol(): string {
  const uints: Array<[string, bigint | number]> = [
    ["LAND_SIZE_TILES", rules.LAND_SIZE_TILES],
    ["INITIAL_STAT_VALUE", rules.INITIAL_STAT_VALUE],
    ["INTENDED_ROUND_SECONDS", rules.INTENDED_ROUND_SECONDS],
    ["RETARGET_INTERVAL_ROUNDS", rules.RETARGET_INTERVAL_ROUNDS],
    ["MAX_RETARGET_FACTOR", rules.MAX_RETARGET_FACTOR],
    ["INITIAL_ROUND_REWARD", rules.INITIAL_ROUND_REWARD],
    ["HALVING_INTERVAL_ROUNDS", rules.HALVING_INTERVAL_ROUNDS],
    ["MAX_SUPPLY", rules.MAX_SUPPLY],
    ["INITIAL_TARGET", rules.INITIAL_TARGET],
  ];
  const keys = rules.CHARACTER_STAT_KEYS;
  return [
    "// SPDX-License-Identifier: MIT",
    "// GENERATED from packages/shared/src/rules by `pnpm --filter @linked-realms/shared generate`. Do not edit.",
    "pragma solidity ^0.8.24;",
    "",
    "library Rules {",
    ...uints.map(
      ([name, value]) =>
        `    uint256 internal constant ${name} = ${solidityNumber(BigInt(value))};`,
    ),
    "",
    "    function characterStatKeys() internal pure returns (bytes32[] memory keys) {",
    `        keys = new bytes32[](${keys.length});`,
    ...keys.map((key, i) => `        keys[${i}] = "${key}";`),
    "    }",
    "}",
    "",
  ].join("\n");
}

export function renderSpiralVectors(): string {
  const indices = [
    ...Array.from({ length: 200 }, (_, n) => n),
    1_000,
    9_999,
    65_535,
    1_000_000,
  ];
  const coordinates = indices.map((n) => rules.spiralCoordinates(n));
  // Parallel arrays, because forge's JSON cheatcodes read whole arrays, not fields of objects.
  const vectors = {
    n: indices,
    x: coordinates.map((c) => c.x),
    y: coordinates.map((c) => c.y),
  };
  return `${JSON.stringify(vectors)}\n`;
}

/** The flat, empty stage 1 Land (Tiled JSON): grass everywhere, the Mine in the middle. */
export function renderEmptyLand(): string {
  const size = rules.LAND_SIZE_TILES;
  const map = {
    type: "map",
    version: "1.10",
    tiledversion: "1.11.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: size,
    height: size,
    tilewidth: TILE_SIZE_PX,
    tileheight: TILE_SIZE_PX,
    nextlayerid: 3,
    nextobjectid: 6,
    tilesets: [{ firstgid: 1, name: "terrain" }],
    layers: [
      {
        id: 1,
        name: "ground",
        type: "tilelayer",
        x: 0,
        y: 0,
        width: size,
        height: size,
        opacity: 1,
        visible: true,
        data: Array<number>(size * size).fill(1),
      },
      {
        id: 2,
        name: "objects",
        type: "objectgroup",
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        draworder: "topdown",
        objects: [
          {
            id: 1,
            name: "mine",
            type: "mine",
            x: MINE_TILES.x * TILE_SIZE_PX,
            y: MINE_TILES.y * TILE_SIZE_PX,
            width: MINE_TILES.width * TILE_SIZE_PX,
            height: MINE_TILES.height * TILE_SIZE_PX,
            rotation: 0,
            visible: true,
          },
          ...rules.DIRECTIONS.map((direction, i) => {
            const g = rules.gateRect(direction);
            return {
              id: i + 2,
              name: `gate-${direction}`,
              type: "gate",
              x: g.tileX * TILE_SIZE_PX,
              y: g.tileY * TILE_SIZE_PX,
              width: g.width * TILE_SIZE_PX,
              height: g.height * TILE_SIZE_PX,
              rotation: 0,
              visible: true,
              properties: [
                { name: "direction", type: "string", value: direction },
              ],
            };
          }),
        ],
      },
    ],
  };
  return `${JSON.stringify(map)}\n`;
}

const hex = (value: bigint) => toHex(value);

/** Solution hashes, Retargets and rewards computed by the TypeScript rules, checked by `forge test`. */
export function renderMiningVectors(): string {
  const solution = Array.from({ length: 16 }, (_, i) => {
    const challenge = keccak256(toHex(`challenge ${i}`));
    const wallet = keccak256(toHex(`wallet ${i}`)).slice(0, 42) as Address;
    const nonce = BigInt(keccak256(toHex(`nonce ${i}`))) >> BigInt(i * 16);
    return {
      challenge,
      wallet,
      nonce: hex(nonce),
      hash: rules.solutionHash(challenge, wallet, nonce),
    };
  });
  const expected =
    rules.INTENDED_ROUND_SECONDS * rules.RETARGET_INTERVAL_ROUNDS;
  const currents = [
    1n,
    2n,
    1_000_000n,
    rules.INITIAL_TARGET,
    2n ** 200n,
    rules.MAX_TARGET / 4n,
    rules.MAX_TARGET / 4n + 1n,
    rules.MAX_TARGET,
  ];
  const actuals = [
    0n,
    1n,
    expected / 4n - 1n,
    expected / 4n,
    expected / 2n,
    expected - 1n,
    expected,
    expected + 7n,
    expected * 4n,
    expected * 4n + 1n,
    10n ** 12n,
  ];
  const retarget = currents.flatMap((current) =>
    actuals.map((actual) => ({
      current: hex(current),
      actual: hex(actual),
      next: hex(rules.nextTarget(current, actual)),
    })),
  );
  const h = rules.HALVING_INTERVAL_ROUNDS;
  const rounds = [
    0n,
    1n,
    h - 1n,
    h,
    h + 1n,
    2n * h,
    4n * h,
    33n * h,
    63n * h,
    64n * h,
    255n * h,
    256n * h,
    2n ** 64n,
  ];
  const reward = rounds.map((round) => ({
    round: hex(round),
    reward: hex(rules.rewardForRound(round)),
  }));
  const columns = <T extends object>(rows: T[]) =>
    Object.fromEntries(
      Object.keys(rows[0]!).map((k) => [k, rows.map((r) => r[k as keyof T])]),
    );
  // Parallel arrays of hex strings: forge's JSON cheatcodes read whole arrays, and uint256 does not fit a JSON number.
  return `${JSON.stringify({ solution: columns(solution), retarget: columns(retarget), reward: columns(reward) })}\n`;
}
