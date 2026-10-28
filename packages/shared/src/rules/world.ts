// World layout (PLAN.md section 5.1). x grows east, y grows south.
import type { LandMap } from "../map/index.ts";

export const LAND_SIZE_TILES = 64;

export interface Coordinates {
  x: number;
  y: number;
}

function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/** Coordinates of spiral index `n` (index 0 is the centre of the world). */
export function spiralCoordinates(n: number): Coordinates {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`invalid spiral index ${n}`);
  if (n === 0) return { x: 0, y: 0 };
  const k = Math.floor((isqrt(n) + 1) / 2);
  const t = n - (2 * k - 1) ** 2;
  if (t < 2 * k) return { x: k, y: -k + 1 + t };
  if (t < 4 * k) return { x: k - 1 - (t - 2 * k), y: k };
  if (t < 6 * k) return { x: -k, y: k - 1 - (t - 4 * k) };
  return { x: -k + 1 + (t - 6 * k), y: -k };
}

/** Land ids start at 1; Land `id` sits at spiral index `id - 1`. */
export function landCoordinates(landId: number): Coordinates {
  return spiralCoordinates(landId - 1);
}

/** Half the side of the square a Character occupies, in pixels. */
export const CHARACTER_HALF_SIZE_PX = 10;

/** Each Land edge has one Gate, this many tiles wide, centred on the edge. */
export const GATE_WIDTH_TILES = 2;

export const DIRECTIONS = ["north", "east", "south", "west"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** The rectangle of tiles a Gate covers, on its edge row or column. */
export interface GateRect {
  tileX: number;
  tileY: number;
  width: number;
  height: number;
}

/** The Gate on `direction`'s edge, centred (tiles 31-32 on a 64-tile edge). */
export function gateRect(direction: Direction): GateRect {
  const start = (LAND_SIZE_TILES - GATE_WIDTH_TILES) / 2;
  const last = LAND_SIZE_TILES - 1;
  switch (direction) {
    case "north":
      return { tileX: start, tileY: 0, width: GATE_WIDTH_TILES, height: 1 };
    case "south":
      return { tileX: start, tileY: last, width: GATE_WIDTH_TILES, height: 1 };
    case "west":
      return { tileX: 0, tileY: start, width: 1, height: GATE_WIDTH_TILES };
    case "east":
      return { tileX: last, tileY: start, width: 1, height: GATE_WIDTH_TILES };
  }
}

/** Coordinates of the Land next to (x, y) across `direction` (north is y - 1, east is x + 1). */
export function neighbourOf(
  x: number,
  y: number,
  direction: Direction,
): Coordinates {
  switch (direction) {
    case "north":
      return { x, y: y - 1 };
    case "south":
      return { x, y: y + 1 };
    case "west":
      return { x: x - 1, y };
    case "east":
      return { x: x + 1, y };
  }
}

/** Walking out through a Gate on `direction` arrives at the opposite Gate of the next Land. */
export function arrivalGate(direction: Direction): Direction {
  return { north: "south", south: "north", east: "west", west: "east" }[
    direction
  ] as Direction;
}

/** The Gate whose tiles the Character's box overlaps, or undefined. */
export function gateOf(
  map: LandMap,
  position: { x: number; y: number },
): Direction | undefined {
  const h = CHARACTER_HALF_SIZE_PX;
  const t = map.tileSize;
  return DIRECTIONS.find((d) => {
    const g = map.gates[d];
    return (
      position.x + h > g.tileX * t &&
      position.x - h < (g.tileX + g.width) * t &&
      position.y + h > g.tileY * t &&
      position.y - h < (g.tileY + g.height) * t
    );
  });
}

/** One tile inside `gate`, centred on it: where a Character arriving through that Gate appears. */
export function gateSpawn(
  map: LandMap,
  gate: Direction,
): { x: number; y: number } {
  const g = map.gates[gate];
  const inward = {
    north: { x: 0, y: 1 },
    south: { x: 0, y: -1 },
    west: { x: 1, y: 0 },
    east: { x: -1, y: 0 },
  }[gate];
  return {
    x: (g.tileX + g.width / 2 + inward.x) * map.tileSize,
    y: (g.tileY + g.height / 2 + inward.y) * map.tileSize,
  };
}
