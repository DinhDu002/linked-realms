// Hash rate of the worker code against a target no hash can meet.
import { Worker } from "node:worker_threads";
import type { FromWorker, ToWorker } from "../src/search.ts";

const threads = Number(process.env.BENCH_THREADS ?? 1);
const seconds = Number(process.env.BENCH_SECONDS ?? 20);

const totals = new Array<number>(threads).fill(0);
const workers: Worker[] = [];
for (let i = 0; i < threads; i++) {
  const worker = new Worker(new URL("../src/worker.ts", import.meta.url));
  worker.on("message", (m: FromWorker) => {
    totals[i] = (totals[i] ?? 0) + m.hashes;
  });
  const job: ToWorker = {
    type: "job",
    id: 1,
    job: {
      challenge: `0x${"11".repeat(32)}`,
      rewardWallet: `0x${"22".repeat(20)}`,
      target: 0n,
      start: BigInt(i),
      stride: threads,
    },
  };
  worker.postMessage(job);
  workers.push(worker);
}

const began = Date.now();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const elapsed = (Date.now() - began) / 1000;
await Promise.all(workers.map((w) => w.terminate()));

const rates = totals.map((n) => n / elapsed);
rates.forEach((r, i) =>
  console.log(`thread ${i}: ${Math.round(r).toLocaleString()} hashes/s`),
);
const total = rates.reduce((a, b) => a + b, 0);
console.log(`total: ${Math.round(total).toLocaleString()} hashes/s`);
const single = Math.max(1, Math.round(total / threads));
const target = 2n ** 256n / (BigInt(single) * 60n);
console.log(
  `INITIAL_TARGET for one Solution per 60 s at ${single.toLocaleString()} hashes/s per thread:`,
);
console.log(`  decimal: ${target}`);
console.log(`  hex:     0x${target.toString(16)}`);
