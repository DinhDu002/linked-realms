import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isBlockedTile, parseLandMap } from "../map/index.ts";
import { step } from "../movement.ts";
import {
  arrivalGate,
  CHARACTER_HALF_SIZE_PX,
  DIRECTIONS,
  gateOf,
  gateSpawn,
  landCoordinates,
  neighbourOf,
  spiralCoordinates,
} from "./world.ts";

describe("spiralCoordinates", () => {
  it("walks the first ring around the centre", () => {
    const ring = Array.from({ length: 9 }, (_, n) => spiralCoordinates(n));
    expect(ring).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: 0 },
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
    ]);
    expect(spiralCoordinates(9)).toEqual({ x: 2, y: -1 });
  });

  it("never repeats a coordinate and keeps consecutive lands adjacent", () => {
    const seen = new Set<string>();
    let previous = spiralCoordinates(0);
    for (let n = 0; n < 10_000; n++) {
      const c = spiralCoordinates(n);
      const key = `${c.x},${c.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      if (n > 0)
        expect(Math.abs(c.x - previous.x) + Math.abs(c.y - previous.y)).toBe(1);
      previous = c;
    }
  });

  it("rejects invalid indices", () => {
    expect(() => spiralCoordinates(-1)).toThrow(RangeError);
    expect(() => spiralCoordinates(1.5)).toThrow(RangeError);
  });

  it("maps Land ids starting at 1", () => {
    expect(landCoordinates(1)).toEqual({ x: 0, y: 0 });
    expect(landCoordinates(2)).toEqual({ x: 1, y: 0 });
  });
});

describe("Gates", () => {
  const map = parseLandMap(
    readFileSync(
      new URL("../../../../maps/empty-land.json", import.meta.url),
      "utf8",
    ),
  );

  it("sit in the middle of each edge", () => {
    expect(map.gates.north).toEqual({
      tileX: 31,
      tileY: 0,
      width: 2,
      height: 1,
    });
    expect(map.gates.south).toEqual({
      tileX: 31,
      tileY: 63,
      width: 2,
      height: 1,
    });
    expect(map.gates.west).toEqual({
      tileX: 0,
      tileY: 31,
      width: 1,
      height: 2,
    });
    expect(map.gates.east).toEqual({
      tileX: 63,
      tileY: 31,
      width: 1,
      height: 2,
    });
  });

  it("neighbourOf and arrivalGate", () => {
    expect(neighbourOf(0, 0, "north")).toEqual({ x: 0, y: -1 });
    expect(neighbourOf(0, 0, "east")).toEqual({ x: 1, y: 0 });
    expect(neighbourOf(0, 0, "south")).toEqual({ x: 0, y: 1 });
    expect(neighbourOf(0, 0, "west")).toEqual({ x: -1, y: 0 });
    for (const d of DIRECTIONS) {
      expect(arrivalGate(arrivalGate(d))).toBe(d);
      const { x, y } = neighbourOf(5, 5, d);
      const back = neighbourOf(x, y, arrivalGate(d));
      expect(back).toEqual({ x: 5, y: 5 });
    }
  });

  it("gateOf finds the Gate a Character stands on, on the edge", () => {
    const h = CHARACTER_HALF_SIZE_PX;
    const mid = 32 * 32;
    expect(gateOf(map, { x: mid, y: h })).toBe("north");
    expect(gateOf(map, { x: mid, y: 64 * 32 - h })).toBe("south");
    expect(gateOf(map, { x: h, y: mid })).toBe("west");
    expect(gateOf(map, { x: 64 * 32 - h, y: mid })).toBe("east");
    // The box only has to touch the Gate tiles.
    expect(gateOf(map, { x: 31 * 32 - h + 1, y: h })).toBe("north");
    expect(gateOf(map, { x: 31 * 32 - h, y: h })).toBeUndefined();
  });

  it("gateOf is undefined away from Gates, also on an edge", () => {
    expect(gateOf(map, { x: mid(), y: mid() })).toBeUndefined();
    expect(
      gateOf(map, { x: 5 * 32, y: CHARACTER_HALF_SIZE_PX }),
    ).toBeUndefined();
  });

  it("a Character can walk onto an edge Gate", () => {
    let p = { x: 32 * 32, y: 5 * 32 };
    for (let i = 0; i < 100; i++)
      p = step(
        map,
        p,
        { up: true, down: false, left: false, right: false },
        100,
      );
    expect(gateOf(map, p)).toBe("north");
  });

  it("gateSpawn is one tile inside, centred, and not on a Gate", () => {
    expect(gateSpawn(map, "north")).toEqual({ x: 32 * 32, y: 1.5 * 32 });
    expect(gateSpawn(map, "south")).toEqual({ x: 32 * 32, y: 62.5 * 32 });
    expect(gateSpawn(map, "west")).toEqual({ x: 1.5 * 32, y: 32 * 32 });
    expect(gateSpawn(map, "east")).toEqual({ x: 62.5 * 32, y: 32 * 32 });
    for (const d of DIRECTIONS) {
      const p = gateSpawn(map, d);
      expect(gateOf(map, p)).toBeUndefined();
      expect(
        isBlockedTile(map, Math.floor(p.x / 32), Math.floor(p.y / 32)),
      ).toBe(false);
    }
  });
});

const mid = () => 20 * 32;
