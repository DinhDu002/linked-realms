import { describe, expect, it } from "vitest";
import { DIRECTIONS } from "./rules/world.ts";
import { GATE_NONE, gateDirection, gateNumber, shortAddress } from "./hub.ts";

describe("Gate numbers", () => {
  it("number north 1 to west 4, and 0 is no Gate", () => {
    expect(DIRECTIONS.map(gateNumber)).toEqual([1, 2, 3, 4]);
    for (const d of DIRECTIONS) expect(gateDirection(gateNumber(d))).toBe(d);
    expect(gateDirection(GATE_NONE)).toBeUndefined();
    expect(gateDirection(5)).toBeUndefined();
  });
});

describe("shortAddress", () => {
  it("keeps tlr1 and the first and last 6 characters that differ", () => {
    expect(
      shortAddress(
        "tlr1qqq6pcg9hrzz8tnya7wl2f5c5w9gngwatvfahg05g22vq86w7v39c9saugmkh",
      ),
    ).toBe("tlr16pcg9h…augmkh");
  });
});
