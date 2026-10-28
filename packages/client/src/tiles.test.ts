import { describe, expect, it } from "vitest";
import type { LandMap } from "@linked-realms/shared";
import { terrainIndex } from "./tiles.ts";

const map = {
  tilesets: [{ firstGid: 1, name: "terrain", tileCount: 4 }],
} as LandMap;

describe("terrainIndex", () => {
  it("maps global ids to tileset indexes", () => {
    expect(terrainIndex(map, 1)).toBe(0);
    expect(terrainIndex(map, 4)).toBe(3);
  });

  it("ignores empty and out-of-range ids", () => {
    expect(terrainIndex(map, 0)).toBeUndefined();
    expect(terrainIndex(map, 5)).toBeUndefined();
  });
});
