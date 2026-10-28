import { describe, expect, it } from "vitest";
import {
  HALVING_INTERVAL_ROUNDS,
  INITIAL_ROUND_REWARD,
  MAX_SUPPLY,
} from "./index.ts";

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
});
