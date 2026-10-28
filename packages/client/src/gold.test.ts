import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { roundsWon } from "./gold.ts";

const player = "0x000000000000000000000000000000000000dEaD";

describe("roundsWon", () => {
  it("filters by reward wallet and returns newest first", async () => {
    let seen: { args?: unknown; fromBlock?: unknown } = {};
    const reader = {
      getContractEvents: async (params: typeof seen) => {
        seen = params;
        return [
          { args: { round: 1n, reward: 5n }, blockNumber: 10n },
          { args: { round: 3n, reward: 5n }, blockNumber: 30n },
          { args: { round: 2n, reward: 5n }, blockNumber: 20n },
        ];
      },
    } as unknown as PublicClient;
    const won = await roundsWon(reader, 31337, player);
    expect(won.map((w) => w.round)).toEqual([3n, 2n, 1n]);
    expect(seen.args).toEqual({ rewardWallet: player });
    expect(typeof seen.fromBlock).toBe("bigint");
  });
});
