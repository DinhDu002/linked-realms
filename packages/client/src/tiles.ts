import type { LandMap } from "@linked-realms/shared";

/** Colours of the built-in "terrain" tileset (4 tiles), drawn in code; nothing is loaded. */
export const TERRAIN_COLORS = ["#4a8c3a", "#3f7a31", "#c9b36a", "#4a7fb5"];

/** Index into the "terrain" tileset for a global tile id, or undefined for empty/foreign ids. */
export function terrainIndex(map: LandMap, gid: number): number | undefined {
  const tileset = map.tilesets.find((t) => t.name === "terrain");
  if (!tileset || gid === 0) return undefined;
  const index = gid - tileset.firstGid;
  return index >= 0 && index < tileset.tileCount ? index : undefined;
}

/** Paints every tile layer onto a canvas, one `tileSize` square per tile. */
export function paintGround(map: LandMap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = map.width * map.tileSize;
  canvas.height = map.height * map.tileSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  for (const layer of map.tileLayers) {
    layer.data.forEach((gid, i) => {
      const index = terrainIndex(map, gid);
      if (index === undefined) return;
      const x = (i % map.width) * map.tileSize;
      const y = Math.floor(i / map.width) * map.tileSize;
      ctx.fillStyle = TERRAIN_COLORS[index] ?? "#000";
      ctx.fillRect(x, y, map.tileSize, map.tileSize);
      // Faint grid line so movement is visible on a flat colour.
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.strokeRect(x + 0.5, y + 0.5, map.tileSize - 1, map.tileSize - 1);
    });
  }
  return canvas;
}
