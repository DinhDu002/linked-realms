import { describe, expect, it } from "vitest";
import { createInputDiffer, padKeys } from "./input.ts";

const idle = { up: false, down: false, left: false, right: false };

describe("createInputDiffer", () => {
  it("reports nothing while no key is pressed", () => {
    expect(createInputDiffer().next(idle)).toBeUndefined();
  });

  it("reports only changes", () => {
    const differ = createInputDiffer();
    const right = { ...idle, right: true };
    expect(differ.next(right)).toEqual(right);
    expect(differ.next({ ...right })).toBeUndefined();
    expect(differ.next({ ...right, up: true })).toEqual({ ...right, up: true });
    expect(differ.next(idle)).toEqual(idle);
    expect(differ.next(idle)).toBeUndefined();
  });
});

describe("padKeys", () => {
  const keys = (...held: string[]) => ({
    up: held.includes("up"),
    down: held.includes("down"),
    left: held.includes("left"),
    right: held.includes("right"),
  });
  const at = (degrees: number, distance = 60) => {
    const r = (degrees * Math.PI) / 180;
    return padKeys(Math.cos(r) * distance, Math.sin(r) * distance, 72);
  };

  it("holds nothing in the middle quarter", () => {
    expect(padKeys(0, 0, 72)).toEqual(idle);
    expect(at(0, 17)).toEqual(idle);
    expect(at(0, 18)).toEqual(keys("right"));
  });

  it("has 8 sectors of 45°, screen y pointing down", () => {
    expect(at(0)).toEqual(keys("right"));
    expect(at(45)).toEqual(keys("down", "right"));
    expect(at(90)).toEqual(keys("down"));
    expect(at(135)).toEqual(keys("down", "left"));
    expect(at(180)).toEqual(keys("left"));
    expect(at(-135)).toEqual(keys("up", "left"));
    expect(at(-90)).toEqual(keys("up"));
    expect(at(-45)).toEqual(keys("up", "right"));
    // the borders sit 22.5° off each axis
    expect(at(-22)).toEqual(keys("right"));
    expect(at(-23)).toEqual(keys("up", "right"));
    expect(at(-67)).toEqual(keys("up", "right"));
    expect(at(-68)).toEqual(keys("up"));
  });

  it("keeps a finger that slid past the rim", () => {
    expect(at(-90, 500)).toEqual(keys("up"));
  });
});
