// The Solution search loop shared by the worker threads, the bench and the tests.
import { createKeccak } from "hash-wasm";
import type { Address, Hex } from "viem";

export interface Job {
  challenge: Hex;
  rewardWallet: Address;
  target: bigint;
  /** First nonce to try; each step adds `stride`. */
  start: bigint;
  stride: number;
}

export interface SearchResult {
  hashes: number;
  nonce?: bigint;
}

const TWO_32 = 2 ** 32;

function hexBytes(hex: Hex, length: number): Uint8Array {
  return Buffer.from(hex.slice(2).padStart(length * 2, "0"), "hex");
}

/** One hasher and one 96-byte input (challenge | 12 zero bytes + address | nonce) per searcher. */
export async function createSearcher() {
  const hasher = await createKeccak(256);
  const input = new Uint8Array(96);
  const view = new DataView(input.buffer);
  const target = new Uint8Array(32);
  let hi = 0;
  let lo = 0;
  let stride = 1;

  function setJob(job: Job): void {
    input.fill(0);
    input.set(hexBytes(job.challenge, 32), 0);
    input.set(hexBytes(job.rewardWallet, 20), 44);
    target.set(hexBytes(`0x${job.target.toString(16)}`, 32));
    // ponytail: only the low 64 bits of the nonce move; the rest stays 0, far below 2^256
    const start = BigInt.asUintN(64, job.start);
    hi = Number(start >> 32n);
    lo = Number(start & 0xffffffffn);
    stride = job.stride;
  }

  /** Tries `count` nonces; stops at the first Solution (hash < target, big-endian). */
  function run(count: number): SearchResult {
    for (let n = 1; n <= count; n++) {
      view.setUint32(88, hi);
      view.setUint32(92, lo);
      hasher.init();
      hasher.update(input);
      const digest = hasher.digest("binary");
      let i = 0;
      while (i < 32 && digest[i] === target[i]) i++;
      if (i < 32 && digest[i]! < target[i]!)
        return { hashes: n, nonce: (BigInt(hi) << 32n) | BigInt(lo) };
      lo += stride;
      if (lo >= TWO_32) {
        lo -= TWO_32;
        hi = (hi + 1) >>> 0;
      }
    }
    return { hashes: count };
  }

  return { setJob, run };
}

/** Messages from the Miner to a worker. */
export type ToWorker =
  { type: "job"; id: number; job: Job } | { type: "pause" };

/** Messages from a worker to the Miner. */
export type FromWorker =
  | { type: "progress"; id: number; hashes: number }
  | { type: "solution"; id: number; nonce: bigint; hashes: number };
