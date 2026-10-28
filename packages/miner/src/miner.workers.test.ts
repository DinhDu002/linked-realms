// Uses a fake Worker to check thread bookkeeping that real workers cannot show.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TARGET } from "@linked-realms/shared";
import type { MinerChain } from "./chain.ts";

const created: FakeWorker[] = [];
class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
  postMessage = vi.fn();
  constructor() {
    super();
    created.push(this);
  }
}
vi.mock("node:worker_threads", () => ({ Worker: FakeWorker }));

const { Miner } = await import("./miner.ts");

const chain: MinerChain = {
  async currentRound() {
    return { round: 1n, challenge: `0x${"00".repeat(32)}`, target: MAX_TARGET };
  },
  async submit() {
    return "won";
  },
};
const make = () =>
  new Miner({
    chain,
    rewardWallet: "0x1234567890abcdef1234567890abcdef12345678",
    maxThreads: 3,
    pollIntervalMs: 20,
    log: () => {},
  });

afterEach(() => {
  created.length = 0;
});

describe("Miner workers", () => {
  it("stop() terminates every worker", async () => {
    const miner = make();
    miner.start(3);
    expect(created).toHaveLength(3);
    await miner.stop();
    for (const w of created) expect(w.terminate).toHaveBeenCalledOnce();
  });

  it("a crashed worker stops mining and reports why", async () => {
    const miner = make();
    miner.start(3);
    created[1]!.emit("error", new Error("wasm failed"));
    expect(miner.status()).toMatchObject({
      on: false,
      threads: 0,
      error: "worker: wasm failed",
    });
    for (const w of created) expect(w.terminate).toHaveBeenCalledOnce();
    miner.start(1);
    expect(miner.status()).toMatchObject({ on: true, threads: 1 });
    expect(miner.status().error).toBeUndefined();
    await miner.stop();
  });

  it("a worker that exits on its own is treated as a crash", async () => {
    const miner = make();
    miner.start(2);
    created[0]!.emit("exit", 1);
    expect(miner.status()).toMatchObject({
      on: false,
      error: "worker: exited with code 1",
    });
  });
});
