import { describe, expect, it } from "vitest";
import { landCoordinates, spiralCoordinates } from "./world.ts";

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
