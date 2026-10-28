import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { BaseError, type Address } from "viem";
import type { MinerChain, RoundInfo } from "./chain.ts";
import type { FromWorker, ToWorker } from "./search.ts";

export interface MinerStatus {
  on: boolean;
  threads: number;
  /** Hashes per second over the last few seconds. */
  hashRate: number;
  round: bigint;
  submitted: number;
  won: number;
  error?: string;
}

export interface MinerOptions {
  chain: MinerChain;
  rewardWallet: Address;
  maxThreads: number;
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

/** max(1, availableParallelism() - 1): leaves one core for the Map server. */
export function defaultMaxThreads(): number {
  return Math.max(1, availableParallelism() - 1);
}

const RATE_WINDOW_MS = 5000;

export class Miner {
  readonly #options: MinerOptions;
  #on = false;
  #workers: Worker[] = [];
  #terminating: Promise<unknown>[] = [];
  #timer: NodeJS.Timeout | undefined;
  /** Bumped on every start/stop so late async results from an old run are dropped. */
  #epoch = 0;
  #jobId = 0;
  #current: RoundInfo | undefined;
  #round = 0n;
  #submitting = false;
  #submitted = 0;
  #won = 0;
  /** Poll errors clear on the next good poll; submit/worker errors on the next good submit. */
  #pollError: string | undefined;
  /** Responses to polls older than the last applied one are dropped (slow RPC, out-of-order replies). */
  #pollSeq = 0;
  #appliedSeq = 0;
  #workError: string | undefined;
  #onSince = 0;
  #samples: { at: number; hashes: number }[] = [];

  constructor(options: MinerOptions) {
    // The thread cap is P5: a fractional or non-positive cap would spawn the wrong number of workers.
    if (!Number.isInteger(options.maxThreads) || options.maxThreads < 1)
      throw new Error(
        `maxThreads must be an integer >= 1, got ${options.maxThreads}`,
      );
    this.#options = options;
  }

  start(threads: number): void {
    const count = Math.min(
      Math.max(1, Number.isFinite(threads) ? Math.floor(threads) : 1),
      this.#options.maxThreads,
    );
    const resize = this.#on;
    if (resize && count === this.#workers.length) return;
    this.#killWorkers();
    this.#epoch++;
    this.#on = true;
    this.#submitting = false;
    if (!resize) {
      this.#pollError = undefined;
      this.#workError = undefined;
      this.#onSince = Date.now();
      this.#samples = [];
      this.#log(
        `MINING ON: ${count} threads, rewards to ${this.#options.rewardWallet}`,
      );
    } else {
      this.#log(`MINING THREADS: ${count}`);
    }
    for (let i = 0; i < count; i++) this.#spawn(this.#epoch);
    this.#current = undefined;
    if (!this.#timer) {
      this.#timer = setInterval(
        () => void this.#poll(),
        this.#options.pollIntervalMs ?? 1000,
      );
    }
    void this.#poll();
  }

  async stop(): Promise<void> {
    if (this.#on) this.#log("MINING OFF");
    this.#on = false;
    this.#epoch++;
    this.#submitting = false;
    this.#current = undefined;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#killWorkers();
    await Promise.all(this.#terminating);
    this.#terminating = [];
  }

  status(): MinerStatus {
    const now = Date.now();
    let hashRate = 0;
    if (this.#on) {
      const recent = this.#samples.filter((s) => now - s.at <= RATE_WINDOW_MS);
      const seconds = Math.min(RATE_WINDOW_MS, now - this.#onSince) / 1000;
      if (seconds > 0)
        hashRate = recent.reduce((sum, s) => sum + s.hashes, 0) / seconds;
    }
    const error = this.#pollError ?? this.#workError;
    return {
      on: this.#on,
      threads: this.#workers.length,
      hashRate,
      round: this.#round,
      submitted: this.#submitted,
      won: this.#won,
      ...(error === undefined ? {} : { error }),
    };
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  /** Logs the full message; returns only a short one for status(), which the room shows to every visitor
   * (viem messages carry the RPC URL, which can hold an API key, and the request body). */
  #fail(what: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    this.#log(`ERROR ${what}: ${message}`);
    const short =
      error instanceof BaseError
        ? error.shortMessage
        : (message.split("\n")[0] ?? "");
    return `${what}: ${short}`;
  }

  #killWorkers(): void {
    for (const worker of this.#workers) {
      worker.removeAllListeners();
      worker.on("error", () => {});
      this.#terminating.push(worker.terminate());
    }
    this.#workers = [];
  }

  #spawn(epoch: number): void {
    const worker = new Worker(new URL("./worker.ts", import.meta.url));
    worker.on("message", (message: FromWorker) => {
      if (epoch !== this.#epoch) return;
      this.#samples.push({ at: Date.now(), hashes: message.hashes });
      const cutoff = Date.now() - RATE_WINDOW_MS;
      while (this.#samples[0] && this.#samples[0].at < cutoff)
        this.#samples.shift();
      if (message.type === "solution" && message.id === this.#jobId)
        void this.#submit(message.nonce, epoch);
    });
    // A dead worker would leave its nonce stride unsearched: stop mining and say why.
    worker.on("error", (error) => this.#crash(epoch, "worker", error));
    worker.on("exit", (code) =>
      this.#crash(epoch, "worker", new Error(`exited with code ${code}`)),
    );
    this.#workers.push(worker);
  }

  #crash(epoch: number, what: string, error: unknown): void {
    if (epoch !== this.#epoch) return;
    const text = this.#fail(what, error);
    void this.stop();
    this.#workError = text;
  }

  #send(worker: Worker, message: ToWorker): void {
    worker.postMessage(message);
  }

  async #poll(): Promise<void> {
    const epoch = this.#epoch;
    if (!this.#on || this.#submitting) return;
    const seq = ++this.#pollSeq;
    let info: RoundInfo;
    try {
      info = await this.#options.chain.currentRound();
    } catch (error) {
      if (epoch === this.#epoch)
        this.#pollError = this.#fail("currentRound", error);
      return;
    }
    if (epoch !== this.#epoch || this.#submitting || seq < this.#appliedSeq)
      return;
    this.#appliedSeq = seq;
    this.#pollError = undefined;
    const cur = this.#current;
    if (
      cur &&
      cur.round === info.round &&
      cur.challenge === info.challenge &&
      cur.target === info.target
    )
      return;
    this.#current = info;
    this.#round = info.round;
    const jobId = ++this.#jobId;
    const start = randomBytes(8).readBigUInt64BE();
    const stride = this.#workers.length;
    this.#workers.forEach((worker, i) =>
      this.#send(worker, {
        type: "job",
        id: jobId,
        job: {
          challenge: info.challenge,
          rewardWallet: this.#options.rewardWallet,
          target: info.target,
          start: start + BigInt(i),
          stride,
        },
      }),
    );
  }

  async #submit(nonce: bigint, epoch: number): Promise<void> {
    if (this.#submitting) return;
    this.#submitting = true;
    for (const worker of this.#workers) this.#send(worker, { type: "pause" });
    let failed = false;
    const round = this.#round;
    this.#log(`Round ${round}: Solution found, submitting`);
    try {
      const outcome = await this.#options.chain.submit(
        round,
        nonce,
        this.#options.rewardWallet,
      );
      if (epoch !== this.#epoch) return;
      this.#submitted++;
      this.#workError = undefined;
      if (outcome === "won") {
        this.#won++;
        this.#log(`Round ${round} won`);
      } else {
        this.#log(`Round ${round} lost to another Solution`);
      }
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#workError = this.#fail("submit", error);
      failed = true;
    }
    this.#submitting = false;
    // Forget the Round so the next read hands out a fresh job even if the Round did not change.
    this.#current = undefined;
    // After an error wait for the next timer tick: a persistent failure must not retry at RPC speed.
    if (!failed) await this.#poll();
  }
}
