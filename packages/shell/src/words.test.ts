import { describe, expect, it } from "vitest";
import {
  normalizeWords,
  passwordProblem,
  pickConfirmPositions,
} from "./words.ts";

describe("words", () => {
  it("normalises spacing and case", () => {
    expect(normalizeWords("  Abandon  ABOUT\nable\t")).toBe(
      "abandon about able",
    );
  });

  it("picks three different positions in order", () => {
    const sequence = [20, 3, 3, 11];
    expect(pickConfirmPositions(24, () => sequence.shift()!)).toEqual([
      3, 11, 20,
    ]);
  });

  it("asks for a password of 8 characters, typed twice", () => {
    expect(passwordProblem("short", "short")).toMatch(/at least 8/);
    expect(passwordProblem("long enough", "long enough!")).toMatch(/differ/);
    expect(passwordProblem("long enough", "long enough")).toBeUndefined();
  });
});
