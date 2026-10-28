// Land maps are data, never code (P6). Every map that crosses a trust boundary goes through
// parseLandMap, which accepts a small subset of the Tiled JSON format and returns only the
// fields the game uses. Images are never loaded from a map: tilesets are referenced by name
// and drawn from the client's own bundle.
import { LAND_SIZE_TILES } from "../rules/world.ts";

export const TILE_SIZE_PX = 32;
export const MAX_MAP_BYTES = 256 * 1024;
export const MAX_LAYERS = 8;
export const MAX_OBJECTS = 256;
/** Built-in tilesets the client knows how to draw, with their tile counts. */
export const BUILT_IN_TILESETS: Readonly<Record<string, number>> = {
  terrain: 4,
};

/** The Mine is 2×2 tiles in the middle of the Land (PLAN.md section 5.1). */
export const MINE_TILES = {
  x: LAND_SIZE_TILES / 2 - 1,
  y: LAND_SIZE_TILES / 2 - 1,
  width: 2,
  height: 2,
} as const;

export interface LandMap {
  width: number;
  height: number;
  tileSize: number;
  /** Row-major global tile ids of each tile layer, `width * height` long. 0 = empty. */
  tileLayers: Array<{ name: string; data: number[] }>;
  tilesets: Array<{ firstGid: number; name: string; tileCount: number }>;
  mine: { tileX: number; tileY: number; width: number; height: number };
}

export class MapValidationError extends Error {
  override name = "MapValidationError";
}

function fail(message: string): never {
  throw new MapValidationError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function int(value: unknown, what: string, min: number, max: number): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    fail(`${what} must be an integer in [${min}, ${max}]`);
  }
  return value as number;
}

function text(value: unknown, what: string, maxLength = 64): string {
  if (typeof value !== "string" || value.length > maxLength)
    fail(`${what} must be a string of at most ${maxLength} characters`);
  return value;
}

function list(value: unknown, what: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength)
    fail(`${what} must be an array of at most ${maxLength} items`);
  return value;
}

/** Validates an untrusted Land map (a JSON string or an already-parsed value). */
export function parseLandMap(input: unknown): LandMap {
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).length > MAX_MAP_BYTES)
      fail(`map exceeds ${MAX_MAP_BYTES} bytes`);
    try {
      input = JSON.parse(input);
    } catch {
      fail("map is not valid JSON");
    }
  }
  const map = record(input, "map");
  if (map.type !== "map") fail('map.type must be "map"');
  if (map.orientation !== "orthogonal")
    fail('map.orientation must be "orthogonal"');
  if (map.infinite !== false) fail("map.infinite must be false");
  const width = int(map.width, "map.width", LAND_SIZE_TILES, LAND_SIZE_TILES);
  const height = int(
    map.height,
    "map.height",
    LAND_SIZE_TILES,
    LAND_SIZE_TILES,
  );
  const tileSize = int(
    map.tilewidth,
    "map.tilewidth",
    TILE_SIZE_PX,
    TILE_SIZE_PX,
  );
  int(map.tileheight, "map.tileheight", TILE_SIZE_PX, TILE_SIZE_PX);

  const tilesets = list(map.tilesets, "map.tilesets", 4).map((raw, i) => {
    const tileset = record(raw, `tilesets[${i}]`);
    const name = text(tileset.name, `tilesets[${i}].name`);
    const tileCount = BUILT_IN_TILESETS[name];
    if (tileCount === undefined)
      fail(`tilesets[${i}] "${name}" is not a built-in tileset`);
    return {
      firstGid: int(tileset.firstgid, `tilesets[${i}].firstgid`, 1, 1 << 16),
      name,
      tileCount,
    };
  });
  const maxGid = Math.max(
    0,
    ...tilesets.map((t) => t.firstGid + t.tileCount - 1),
  );

  const tileLayers: LandMap["tileLayers"] = [];
  let mine: LandMap["mine"] | undefined;
  for (const [i, raw] of list(map.layers, "map.layers", MAX_LAYERS).entries()) {
    const layer = record(raw, `layers[${i}]`);
    const name = text(layer.name, `layers[${i}].name`);
    if (layer.type === "tilelayer") {
      int(layer.width, `layers[${i}].width`, width, width);
      int(layer.height, `layers[${i}].height`, height, height);
      const data = list(layer.data, `layers[${i}].data`, width * height);
      if (data.length !== width * height)
        fail(`layers[${i}].data must hold ${width * height} tiles`);
      tileLayers.push({
        name,
        data: data.map((gid, j) =>
          int(gid, `layers[${i}].data[${j}]`, 0, maxGid),
        ),
      });
    } else if (layer.type === "objectgroup") {
      for (const [j, rawObject] of list(
        layer.objects,
        `layers[${i}].objects`,
        MAX_OBJECTS,
      ).entries()) {
        const object = record(rawObject, `layers[${i}].objects[${j}]`);
        const kind = object.type ?? object.class;
        if (kind !== "mine") continue;
        if (mine) fail("a Land has exactly one Mine");
        const px = width * tileSize;
        mine = {
          tileX: int(object.x, "mine.x", 0, px) / tileSize,
          tileY: int(object.y, "mine.y", 0, px) / tileSize,
          width: int(object.width, "mine.width", 0, px) / tileSize,
          height: int(object.height, "mine.height", 0, px) / tileSize,
        };
      }
    } else {
      fail(`layers[${i}].type must be "tilelayer" or "objectgroup"`);
    }
  }
  if (!mine) fail("a Land has exactly one Mine");
  if (
    mine.tileX !== MINE_TILES.x ||
    mine.tileY !== MINE_TILES.y ||
    mine.width !== MINE_TILES.width ||
    mine.height !== MINE_TILES.height
  ) {
    fail("the Mine must cover the 2×2 tiles in the middle of the Land");
  }
  if (tileLayers.length === 0) fail("a Land needs at least one tile layer");
  return { width, height, tileSize, tileLayers, tilesets, mine };
}

/** Whether a tile blocks movement. In stage 1 only the Mine does. */
export function isBlockedTile(
  map: LandMap,
  tileX: number,
  tileY: number,
): boolean {
  if (tileX < 0 || tileY < 0 || tileX >= map.width || tileY >= map.height)
    return true;
  const { mine } = map;
  return (
    tileX >= mine.tileX &&
    tileX < mine.tileX + mine.width &&
    tileY >= mine.tileY &&
    tileY < mine.tileY + mine.height
  );
}
