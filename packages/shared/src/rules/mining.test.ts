import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINING_PARAMS,
  HALVING_INTERVAL_ROUNDS,
  INITIAL_ROUND_REWARD,
  MAX_SUPPLY,
  MAX_TARGET,
  meetsTarget,
  nextTarget,
  rewardForRound,
  solutionHash,
} from "./mining.ts";

describe("issuance schedule", () => {
  it("never mints more than the supply cap across every halving", () => {
    let total = 0n;
    let halvings = 0n;
    for (let reward = INITIAL_ROUND_REWARD; reward > 0n; reward >>= 1n) {
      total += reward * HALVING_INTERVAL_ROUNDS;
      halvings += 1n;
    }

    expect(total).toBeLessThanOrEqual(MAX_SUPPLY);
    // Integer halving drops under 1 wei per round at each step, so only dust stays unminted.
    expect(MAX_SUPPLY - total).toBeLessThan(halvings * HALVING_INTERVAL_ROUNDS);
  });

  it("halves at the right Round", () => {
    expect(rewardForRound(0n)).toBe(INITIAL_ROUND_REWARD);
    expect(rewardForRound(HALVING_INTERVAL_ROUNDS - 1n)).toBe(
      INITIAL_ROUND_REWARD,
    );
    expect(rewardForRound(HALVING_INTERVAL_ROUNDS)).toBe(
      INITIAL_ROUND_REWARD / 2n,
    );
    expect(rewardForRound(HALVING_INTERVAL_ROUNDS * 4n)).toBe(
      INITIAL_ROUND_REWARD / 16n,
    );
    expect(rewardForRound(HALVING_INTERVAL_ROUNDS * 256n)).toBe(0n);
  });
});

describe("nextTarget", () => {
  const expected =
    DEFAULT_MINING_PARAMS.intendedRoundSeconds *
    DEFAULT_MINING_PARAMS.retargetIntervalRounds;

  it("keeps the Target when Rounds took the intended time", () => {
    expect(nextTarget(1_000_000n, expected)).toBe(1_000_000n);
  });

  it("follows actual / intended time", () => {
    expect(nextTarget(1_000_000n, expected * 2n)).toBe(2_000_000n);
    expect(nextTarget(1_000_000n, expected / 2n)).toBe(500_000n);
  });

  it("never changes by more than 4× either way", () => {
    expect(nextTarget(1_000_000n, expected * 100n)).toBe(4_000_000n);
    expect(nextTarget(1_000_000n, 0n)).toBe(250_000n);
  });

  it("saturates instead of overflowing and never reaches zero", () => {
    expect(nextTarget(MAX_TARGET, expected * 4n)).toBe(MAX_TARGET);
    expect(nextTarget(1n, 0n)).toBe(1n);
  });
});

describe("solutionHash", () => {
  it("matches abi.encode(bytes32, address, uint256)", () => {
    const hash = solutionHash(
      `0x${"00".repeat(31)}01`,
      "0x0000000000000000000000000000000000000002",
      3n,
    );
    expect(hash).toBe(
      "0x6e0c627900b24bd432fe7b1f713f1b0744091a646a9fe4a65a18dfed21f2949c",
    );
  });

  it("compares against the Target as an unsigned integer", () => {
    expect(meetsTarget("0x00ff", 0x100n)).toBe(true);
    expect(meetsTarget("0x0100", 0x100n)).toBe(false);
  });
});
