import { describe, expect, it } from "vitest";
import { miningLabel, readMining } from "./mining.ts";

const ok = {
  on: true,
  threads: 2,
  hashRate: 3_340_000,
  round: 42,
  submitted: 4,
  won: 3,
};

describe("readMining", () => {
  it("accepts a well-formed state", () => {
    expect(readMining({ ...ok, extra: 1 })).toEqual(ok);
  });

  it.each([
    null,
    "on",
    { ...ok, on: "yes" },
    { ...ok, hashRate: Number.NaN },
    { ...ok, hashRate: -1 },
    { ...ok, threads: 1.5 },
    { ...ok, round: -1 },
    { ...ok, won: "3" },
    { ...ok, submitted: undefined },
  ])("rejects %j", (value) => {
    expect(readMining(value)).toBeUndefined();
  });
});

describe("miningLabel", () => {
  it("shows the running miner", () => {
    expect(miningLabel(ok)).toBe(
      "Mine: ON, 2 threads, 3.34 MH/s, Round 42, won 3",
    );
    expect(miningLabel({ ...ok, threads: 1 })).toContain("1 thread,");
  });
  it("shows off and unavailable", () => {
    expect(miningLabel({ ...ok, on: false })).toBe("Mine: off");
    expect(miningLabel(undefined)).toBe("Mine: unavailable");
  });
});
