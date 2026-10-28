import { afterEach, describe, expect, it } from "vitest";
import { MAX_TARGET, meetsTarget, solutionHash } from "@linked-realms/shared";
import { BaseError, type Address, type Hex } from "viem";
import type { MinerChain, RoundInfo, SubmitOutcome } from "./chain.ts";
import { Miner, defaultMaxThreads } from "./miner.ts";

const WALLET: Address = "0x1234567890abcdef1234567890abcdef12345678";
const EASY = MAX_TARGET / 4n;
const never = 0n;

const info = (round: bigint, target = EASY): RoundInfo => ({
  round,
  challenge: `0x${round.toString(16).padStart(64, "0")}` as Hex,
  target,
});

class FakeChain implements MinerChain {
  info: RoundInfo;
  outcome: SubmitOutcome = "won";
  readError: Error | undefined;
  submitError: Error | undefined;
  submits: { round: bigint; nonce: bigint; wallet: Address }[] = [];
  constructor(first: RoundInfo) {
    this.info = first;
  }
  /** When set, each currentRound() call waits for its own gate and returns what `info` was at call time. */
  gates: (() => void)[] | undefined;
  async currentRound() {
    if (this.readError) throw this.readError;
    const info = this.info;
    if (this.gates) await new Promise<void>((r) => this.gates!.push(r));
    return info;
  }
  async submit(round: bigint, nonce: bigint, wallet: Address) {
    this.submits.push({ round, nonce, wallet });
    if (this.submitError) throw this.submitError;
    // A real win starts the next Round.
    if (this.outcome === "won") this.info = info(round + 1n, never);
    return this.outcome;
  }
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const miners: Miner[] = [];
function make(chain: MinerChain, maxThreads = 2, pollIntervalMs = 20) {
  const lines: string[] = [];
  const miner = new Miner({
    chain,
    rewardWallet: WALLET,
    maxThreads,
    pollIntervalMs,
    log: (l) => lines.push(l),
  });
  miners.push(miner);
  return { miner, lines };
}
afterEach(async () => {
  await Promise.all(miners.splice(0).map((m) => m.stop()));
});

describe("Miner", () => {
  it("does nothing until started", async () => {
    const chain = new FakeChain(info(1n));
    const { miner } = make(chain);
    await new Promise((r) => setTimeout(r, 100));
    expect(miner.status()).toMatchObject({
      on: false,
      threads: 0,
      hashRate: 0,
    });
    expect(chain.submits).toHaveLength(0);
  });

  it("finds a valid Solution, submits it and counts the win", async () => {
    const chain = new FakeChain(info(1n));
    const { miner, lines } = make(chain);
    miner.start(2);
    await until(() => miner.status().won === 1);
    const [s] = chain.submits;
    expect(s!.round).toBe(1n);
    expect(s!.wallet).toBe(WALLET);
    expect(
      meetsTarget(solutionHash(info(1n).challenge, WALLET, s!.nonce), EASY),
    ).toBe(true);
    expect(miner.status()).toMatchObject({
      on: true,
      submitted: 1,
      won: 1,
      round: 2n,
    });
    expect(lines).toContain(`MINING ON: 2 threads, rewards to ${WALLET}`);
    expect(lines).toContain("Round 1: Solution found, submitting");
    expect(lines).toContain("Round 1 won");
  });

  it("counts a lost submit as submitted, not won, and keeps mining", async () => {
    const chain = new FakeChain(info(1n));
    chain.outcome = "lost";
    const { miner, lines } = make(chain);
    miner.start(1);
    await until(() => chain.submits.length >= 2);
    expect(miner.status().won).toBe(0);
    expect(miner.status().submitted).toBeGreaterThanOrEqual(1);
    expect(lines).toContain("Round 1 lost to another Solution");
  });

  it("abandons stale work when the Round changes", async () => {
    const chain = new FakeChain(info(1n, never));
    const { miner } = make(chain);
    miner.start(1);
    await until(() => miner.status().hashRate > 0);
    expect(chain.submits).toHaveLength(0);
    chain.info = info(2n, EASY);
    await until(() => chain.submits.length > 0);
    expect(chain.submits[0]!.round).toBe(2n);
  });

  it("clamps threads and applies a new count while on", async () => {
    const chain = new FakeChain(info(1n, never));
    const { miner } = make(chain, 3);
    miner.start(99);
    expect(miner.status().threads).toBe(3);
    miner.start(0);
    expect(miner.status().threads).toBe(1);
    expect(miner.status().on).toBe(true);
    await until(() => miner.status().hashRate > 0);
  });

  it("treats a non-finite thread count as 1 and rejects a bad cap", () => {
    const { miner } = make(new FakeChain(info(1n, never)), 3);
    miner.start(Number("abc"));
    expect(miner.status().threads).toBe(1);
    for (const maxThreads of [2.5, 0, -1, Number.NaN])
      expect(
        () =>
          new Miner({
            chain: new FakeChain(info(1n)),
            rewardWallet: WALLET,
            maxThreads,
          }),
      ).toThrow(/maxThreads/);
  });

  it("stop() terminates every worker", async () => {
    const chain = new FakeChain(info(1n, never));
    const { miner, lines } = make(chain);
    miner.start(2);
    await until(() => miner.status().hashRate > 0);
    await miner.stop();
    expect(miner.status()).toMatchObject({
      on: false,
      threads: 0,
      hashRate: 0,
    });
    expect(lines).toContain("MINING OFF");
    const seen = chain.submits.length;
    chain.info = info(2n, EASY);
    await new Promise((r) => setTimeout(r, 100));
    expect(chain.submits).toHaveLength(seen);
  });

  it("reports chain errors in status() and recovers on the next poll", async () => {
    const chain = new FakeChain(info(1n));
    chain.readError = new Error("rpc down");
    const { miner } = make(chain);
    miner.start(1);
    await until(() => miner.status().error?.includes("rpc down") === true);
    expect(miner.status().on).toBe(true);
    chain.readError = undefined;
    await until(() => miner.status().won === 1);
    expect(miner.status().error).toBeUndefined();
  });

  it("keeps the RPC URL and request body out of status()", async () => {
    const chain = new FakeChain(info(1n));
    chain.readError = new BaseError("HTTP request failed.", {
      details: "https://host/v2/SECRETAPIKEY",
    });
    chain.readError.message += "\nURL: https://host/v2/SECRETAPIKEY";
    const { miner, lines } = make(chain);
    miner.start(1);
    await until(() => miner.status().error !== undefined);
    expect(miner.status().error).toBe("currentRound: HTTP request failed.");
    expect(lines.join("\n")).toContain("SECRETAPIKEY");
    chain.readError = new Error("first line\nsecond SECRETAPIKEY line");
    await until(() => miner.status().error?.includes("first line") === true);
    expect(miner.status().error).toBe("currentRound: first line");
  });

  it("ignores a slow poll that answers after a newer one", async () => {
    const chain = new FakeChain(info(1n, never));
    chain.gates = [];
    const { miner } = make(chain, 1, 30);
    miner.start(1);
    await until(() => chain.gates!.length >= 2); // poll 1 (round 1) and poll 2 (round 1)
    chain.info = info(2n, never);
    await until(() => chain.gates!.length >= 3); // poll 3 sees round 2
    const [first, , third] = chain.gates!;
    third!(); // newer poll answers first
    await until(() => miner.status().round === 2n);
    first!(); // older poll answers late: must not move the Round back
    await new Promise((r) => setTimeout(r, 50));
    expect(miner.status().round).toBe(2n);
  });

  it("does not retry a failing submit at RPC speed", async () => {
    const chain = new FakeChain(info(1n));
    chain.submitError = new Error("insufficient funds");
    const { miner } = make(chain, 1, 200);
    miner.start(1);
    await until(() => chain.submits.length >= 1);
    await new Promise((r) => setTimeout(r, 450));
    expect(chain.submits.length).toBeLessThanOrEqual(4);
    expect(miner.status().error).toContain("insufficient funds");
  });

  it("reports submit errors and retries", async () => {
    const chain = new FakeChain(info(1n));
    chain.submitError = new Error("out of gas");
    const { miner } = make(chain);
    miner.start(1);
    await until(() => miner.status().error?.includes("out of gas") === true);
    chain.submitError = undefined;
    await until(() => miner.status().won === 1);
  });
});

describe("defaultMaxThreads", () => {
  it("is at least 1", () => {
    expect(defaultMaxThreads()).toBeGreaterThanOrEqual(1);
  });
});
