import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_TARGET, meetsTarget, solutionHash } from "@linked-realms/shared";
import type { Address, Hex } from "viem";
import { createSearcher } from "./search.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../shared/test-vectors/mining.json", import.meta.url),
    "utf8",
  ),
) as {
  solution: {
    challenge: Hex[];
    wallet: Address[];
    nonce: Hex[];
    hash: Hex[];
  };
};

const CHALLENGE: Hex = `0x${"ab".repeat(32)}`;
const WALLET: Address = "0x1234567890abcdef1234567890abcdef12345678";

describe("search", () => {
  it("finds exactly the vector nonce when the target is its hash + 1", async () => {
    const s = await createSearcher();
    const v = vectors.solution;
    for (let i = 0; i < v.nonce.length; i++) {
      const nonce = BigInt(v.nonce[i]!);
      const hash = solutionHash(v.challenge[i]!, v.wallet[i]!, nonce);
      expect(hash).toBe(v.hash[i]);
      // Vector nonces are 256-bit; the search moves the low 64 bits only.
      if (nonce >= 2n ** 64n) continue;
      s.setJob({
        challenge: v.challenge[i]!,
        rewardWallet: v.wallet[i]!,
        target: BigInt(hash) + 1n,
        start: nonce,
        stride: 1,
      });
      expect(s.run(1)).toEqual({ hashes: 1, nonce });
    }
  });

  it("agrees with solutionHash/meetsTarget on every nonce it tries", async () => {
    const s = await createSearcher();
    const target = MAX_TARGET / 4n;
    const start = 2n ** 32n - 5n; // crosses the 32-bit carry
    const stride = 3;
    s.setJob({
      challenge: CHALLENGE,
      rewardWallet: WALLET,
      target,
      start,
      stride,
    });
    let nonce = start;
    for (let i = 0; i < 40; i++) {
      const expected = meetsTarget(
        solutionHash(CHALLENGE, WALLET, nonce),
        target,
      );
      const result = s.run(1);
      expect(result.nonce !== undefined).toBe(expected);
      if (expected) {
        expect(result.nonce).toBe(nonce);
        s.setJob({
          challenge: CHALLENGE,
          rewardWallet: WALLET,
          target,
          start: nonce + BigInt(stride),
          stride,
        });
      }
      nonce += BigInt(stride);
    }
  });

  it("never finds anything under target 0", async () => {
    const s = await createSearcher();
    s.setJob({
      challenge: CHALLENGE,
      rewardWallet: WALLET,
      target: 0n,
      start: 0n,
      stride: 1,
    });
    expect(s.run(500)).toEqual({ hashes: 500 });
  });

  it("handles the extreme and byte-boundary targets like meetsTarget", async () => {
    const s = await createSearcher();
    const job = {
      challenge: CHALLENGE,
      rewardWallet: WALLET,
      start: 0n,
      stride: 1,
    };
    s.setJob({ ...job, target: MAX_TARGET });
    expect(s.run(1)).toEqual({ hashes: 1, nonce: 0n });
    s.setJob({ ...job, target: 1n });
    expect(s.run(500)).toEqual({ hashes: 500 });
    // Targets with leading zero bytes and with the top bit set.
    for (const target of [2n ** 255n, 2n ** 200n, 2n ** 248n + 1n]) {
      s.setJob({ ...job, target });
      let expected: bigint | undefined;
      for (let n = 0n; n < 5000n && expected === undefined; n++)
        if (meetsTarget(solutionHash(CHALLENGE, WALLET, n), target))
          expected = n;
      expect(s.run(5000).nonce).toBe(expected);
    }
  });
});
