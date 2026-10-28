// Off-chain movement inside a Land. The map server is authoritative and uses `step`;
// the client may use the same function to predict its own movement.
import { isBlockedTile, type LandMap } from "./map/index.ts";
import { CHARACTER_HALF_SIZE_PX } from "./rules/world.ts";

// Defined in rules/world.ts (Gate geometry needs it); re-exported for existing importers.
export { CHARACTER_HALF_SIZE_PX };

export const SERVER_TICK_HZ = 20;
export const MOVE_SPEED_PX_PER_SECOND = 128;

export interface MoveInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface Position {
  x: number;
  y: number;
}

/** Spawn point inside a Land: just south of the Mine. */
export function spawnPosition(map: LandMap): Position {
  return {
    x: (map.mine.tileX + map.mine.width / 2) * map.tileSize,
    y: (map.mine.tileY + map.mine.height + 1.5) * map.tileSize,
  };
}

function overlapsBlocked(map: LandMap, p: Position): boolean {
  const h = CHARACTER_HALF_SIZE_PX;
  const left = Math.floor((p.x - h) / map.tileSize);
  const right = Math.floor((p.x + h - 1e-6) / map.tileSize);
  const top = Math.floor((p.y - h) / map.tileSize);
  const bottom = Math.floor((p.y + h - 1e-6) / map.tileSize);
  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (isBlockedTile(map, tx, ty)) return true;
    }
  }
  return false;
}

/** Moves a Character for `dtMs` milliseconds; each axis stops at walls and the Land's edge. */
export function step(
  map: LandMap,
  from: Position,
  input: MoveInput,
  dtMs: number,
): Position {
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  if (dx === 0 && dy === 0) return from;
  const length = Math.hypot(dx, dy);
  const distance =
    (MOVE_SPEED_PX_PER_SECOND * Math.min(Math.max(dtMs, 0), 250)) / 1000;
  dx = (dx / length) * distance;
  dy = (dy / length) * distance;
  let next = { x: from.x + dx, y: from.y };
  if (overlapsBlocked(map, next)) next = { x: from.x, y: from.y };
  const moved = { x: next.x, y: next.y + dy };
  return overlapsBlocked(map, moved) ? next : moved;
}
