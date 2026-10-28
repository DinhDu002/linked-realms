import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLandMap } from "./map/index.ts";
import {
  CHARACTER_HALF_SIZE_PX,
  MOVE_SPEED_PX_PER_SECOND,
  spawnPosition,
  step,
  type MoveInput,
} from "./movement.ts";

const map = parseLandMap(
  readFileSync(
    new URL("../../../maps/empty-land.json", import.meta.url),
    "utf8",
  ),
);
const none: MoveInput = { up: false, down: false, left: false, right: false };

describe("step", () => {
  it("moves at the configured speed", () => {
    const from = { x: 100, y: 100 };
    expect(step(map, from, { ...none, right: true }, 200)).toEqual({
      x: 100 + MOVE_SPEED_PX_PER_SECOND * 0.2,
      y: 100,
    });
  });

  it("does not move faster diagonally", () => {
    const to = step(
      map,
      { x: 300, y: 300 },
      { ...none, down: true, right: true },
      200,
    );
    expect(Math.hypot(to.x - 300, to.y - 300)).toBeCloseTo(
      MOVE_SPEED_PX_PER_SECOND * 0.2,
    );
  });

  it("caps a single step so a stalled tick cannot teleport", () => {
    const to = step(map, { x: 100, y: 100 }, { ...none, right: true }, 60_000);
    expect(to.x - 100).toBeLessThanOrEqual(MOVE_SPEED_PX_PER_SECOND / 4);
  });

  it("stops at the edge of the Land", () => {
    let p = { x: 50, y: 50 };
    for (let i = 0; i < 100; i++)
      p = step(map, p, { ...none, up: true, left: true }, 100);
    expect(p.x).toBeGreaterThanOrEqual(CHARACTER_HALF_SIZE_PX);
    expect(p.y).toBeGreaterThanOrEqual(CHARACTER_HALF_SIZE_PX);
  });

  it("cannot walk through the Mine", () => {
    let p = spawnPosition(map);
    for (let i = 0; i < 100; i++) p = step(map, p, { ...none, up: true }, 100);
    expect(p.y - CHARACTER_HALF_SIZE_PX).toBeGreaterThanOrEqual(
      (map.mine.tileY + map.mine.height) * map.tileSize,
    );
  });

  it("spawns outside the Mine", () => {
    const p = spawnPosition(map);
    expect(step(map, p, none, 50)).toEqual(p);
    expect(step(map, p, { ...none, down: true }, 50).y).toBeGreaterThan(p.y);
  });
});
