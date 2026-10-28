import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isBlockedTile,
  MAX_MAP_BYTES,
  MapValidationError,
  parseLandMap,
} from "./index.ts";

const emptyLand = readFileSync(
  new URL("../../../../maps/empty-land.json", import.meta.url),
  "utf8",
);
const clone = () => JSON.parse(emptyLand);

describe("parseLandMap", () => {
  it("accepts the stage 1 empty Land", () => {
    const map = parseLandMap(emptyLand);
    expect(map.width).toBe(64);
    expect(map.tileLayers[0]!.data).toHaveLength(64 * 64);
    expect(map.mine).toEqual({ tileX: 31, tileY: 31, width: 2, height: 2 });
  });

  it("keeps only the fields the game uses", () => {
    const raw = clone();
    raw.tilesets[0].image = "https://evil.example/x.png";
    raw.properties = [{ name: "script", value: "alert(1)" }];
    const map = parseLandMap(raw);
    expect(JSON.stringify(map)).not.toContain("evil");
    expect(JSON.stringify(map)).not.toContain("alert");
  });

  const rejects: Array<[string, (m: ReturnType<typeof clone>) => unknown]> = [
    ["a wrong width", (m) => ((m.width = 65), m)],
    ["an infinite map", (m) => ((m.infinite = true), m)],
    ["an unknown tileset", (m) => ((m.tilesets[0].name = "remote"), m)],
    ["a tile id outside the tilesets", (m) => ((m.layers[0].data[5] = 99), m)],
    ["a non-integer tile id", (m) => ((m.layers[0].data[5] = "1"), m)],
    ["short layer data", (m) => (m.layers[0].data.pop(), m)],
    ["an unknown layer type", (m) => ((m.layers[1].type = "imagelayer"), m)],
    ["a missing Mine", (m) => ((m.layers[1].objects = []), m)],
    [
      "a second Mine",
      (m) => (
        m.layers[1].objects.push({ ...m.layers[1].objects[0], id: 2 }),
        m
      ),
    ],
    ["a Mine off centre", (m) => ((m.layers[1].objects[0].x = 0), m)],
    ["too many layers", (m) => ((m.layers = Array(9).fill(m.layers[0])), m)],
    ["a non-object", () => 42],
    ["broken JSON", () => "{"],
    ["an oversized document", () => " ".repeat(MAX_MAP_BYTES + 1)],
  ];
  it.each(rejects)("rejects %s", (_, mutate) => {
    expect(() => parseLandMap(mutate(clone()))).toThrow(MapValidationError);
  });
});

describe("isBlockedTile", () => {
  const map = parseLandMap(emptyLand);
  it("blocks the Mine and everything outside the Land", () => {
    expect(isBlockedTile(map, 31, 31)).toBe(true);
    expect(isBlockedTile(map, 32, 32)).toBe(true);
    expect(isBlockedTile(map, 30, 31)).toBe(false);
    expect(isBlockedTile(map, -1, 0)).toBe(true);
    expect(isBlockedTile(map, 64, 0)).toBe(true);
  });
});
