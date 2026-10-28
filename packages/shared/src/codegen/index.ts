// Renders the artefacts that carry the TypeScript rules into the contracts (P9):
// contracts/src/generated/Rules.sol and the cross-check vectors read by `forge test`.
import { MINE_TILES, TILE_SIZE_PX } from "../map/index.ts";
import * as rules from "../rules/index.ts";

const repoRoot = new URL("../../../../", import.meta.url);

export const outputs = {
  rulesSol: new URL("contracts/src/generated/Rules.sol", repoRoot),
  spiralVectors: new URL("packages/shared/test-vectors/spiral.json", repoRoot),
  emptyLand: new URL("maps/empty-land.json", repoRoot),
} as const;

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
  ];
  const keys = rules.CHARACTER_STAT_KEYS;
  return [
    "// SPDX-License-Identifier: MIT",
    "// GENERATED from packages/shared/src/rules by `pnpm --filter @linked-realms/shared generate`. Do not edit.",
    "pragma solidity ^0.8.24;",
    "",
    "library Rules {",
    ...uints.map(
      ([name, value]) => `    uint256 internal constant ${name} = ${value};`,
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
    nextobjectid: 2,
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
        ],
      },
    ],
  };
  return `${JSON.stringify(map)}\n`;
}
