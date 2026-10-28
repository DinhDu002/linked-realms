import { describe, expect, it } from "vitest";
import { approach, SMOOTHING_MS } from "./interpolate.ts";

describe("approach", () => {
  it("stays put with no time elapsed", () => {
    expect(approach(10, 20, 0)).toBe(10);
  });

  it("covers about 63% of the gap in one time constant", () => {
    expect(approach(0, 100, SMOOTHING_MS)).toBeCloseTo(63.2, 1);
  });

  it("is independent of how the time is sliced", () => {
    const once = approach(0, 100, 40);
    const twice = approach(approach(0, 100, 20), 100, 20);
    expect(twice).toBeCloseTo(once, 6);
  });

  it("never overshoots", () => {
    expect(approach(0, 100, 1e6)).toBeLessThanOrEqual(100);
  });

  it("snaps after a teleport", () => {
    expect(approach(0, 5000, 16)).toBe(5000);
  });
});
