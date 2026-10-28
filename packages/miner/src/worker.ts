// Worker thread: hashes in batches and yields between them so job/pause messages are handled quickly.
import { parentPort } from "node:worker_threads";
import { createSearcher } from "./search.ts";
import type { FromWorker, ToWorker } from "./search.ts";

const BATCH = 20_000;
const REPORT_MS = 250;

const port = parentPort!;
const searcher = await createSearcher();
let jobId = 0;
let active = false;
let looping = false;
let pending = 0;
let lastReport = Date.now();

function post(message: FromWorker): void {
  port.postMessage(message);
}

function step(): void {
  if (!active) {
    looping = false;
    return;
  }
  const { hashes, nonce } = searcher.run(BATCH);
  pending += hashes;
  if (nonce !== undefined) {
    active = false;
    post({ type: "solution", id: jobId, nonce, hashes: pending });
    pending = 0;
  } else if (Date.now() - lastReport >= REPORT_MS) {
    post({ type: "progress", id: jobId, hashes: pending });
    pending = 0;
    lastReport = Date.now();
  }
  setImmediate(step);
}

port.on("message", (message: ToWorker) => {
  if (message.type === "pause") {
    active = false;
    return;
  }
  searcher.setJob(message.job);
  jobId = message.id;
  pending = 0;
  active = true;
  if (!looping) {
    looping = true;
    lastReport = Date.now();
    setImmediate(step);
  }
});
