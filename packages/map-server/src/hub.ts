// The Map server's calls to the Hub (docs/protocols/map-server-hub-relay.md).
import type { Key } from "@linked-realms/core";
import type { LandInfo } from "@linked-realms/shared";
import { signStatement } from "@linked-realms/shared/identity";
import type { Config } from "./config.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const POLL_MS = 10_000;
// The Hub forgets a Map server statement that serves no Land after 7 days.
const REPOST_MS = 24 * 60 * 60 * 1000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

type HubConfig = Pick<Config, "hubUrl" | "hubDomain" | "landOwner">;

/** Resolves after `ms`, or early when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** Posts a fresh Map server statement once. 204 and 409 (a newer one exists) both count as done. */
export async function postStatement(
  config: HubConfig,
  key: Key,
  log: (message: string) => void,
  now: () => number = Date.now,
): Promise<void> {
  const signed = signStatement(
    "map-server",
    {
      hub: config.hubDomain,
      owner: config.landOwner,
      mapServerKey: key.address,
      issued: Math.floor(now() / 1000),
    },
    key,
  );
  const response = await fetch(new URL("/map-servers", config.hubUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 409)
    return log("The Hub already holds a newer statement from this key");
  if (!response.ok)
    throw new Error(`the Hub answered ${response.status} to POST /map-servers`);
}

/** Posts until it works, backing off while the Hub is unreachable. Returns early on abort. */
export async function registerMapServer(
  post: () => Promise<void>,
  log: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let backoff = INITIAL_BACKOFF_MS;
  while (!signal.aborted) {
    try {
      await post();
      return;
    } catch (error) {
      log(
        `could not register with the Hub (${(error as Error).message}); retrying in ${backoff / 1000} s`,
      );
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

/** The Land this key serves, or undefined if the Hub has none (404). */
export async function findLand(
  config: Pick<Config, "hubUrl">,
  mapServerKey: string,
): Promise<LandInfo | undefined> {
  const url = new URL("/lands", config.hubUrl);
  url.searchParams.set("mapServerKey", mapServerKey);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`the Hub answered ${response.status} to GET /lands`);
  const land = (await response.json()) as Partial<LandInfo> | null;
  if (
    !Number.isSafeInteger(land?.landId) ||
    (land?.landId as number) < 1 ||
    typeof land?.owner !== "string" ||
    typeof land.ownerName !== "string"
  )
    throw new Error("the Hub sent a malformed Land");
  return land as LandInfo;
}

export interface AwaitLandOptions {
  find: () => Promise<LandInfo | undefined>;
  /** Posts a fresh statement; failures are logged, not fatal. */
  repost: () => Promise<void>;
  owner: string;
  log: (message: string) => void;
  signal: AbortSignal;
  pollMs?: number;
  repostMs?: number;
}

/**
 * Polls until the Hub has a Land for this key whose owner is `owner`; undefined if aborted first.
 * While it waits, it posts a fresh statement every day, because the Hub drops an unused one.
 */
export async function awaitLand(
  options: AwaitLandOptions,
): Promise<LandInfo | undefined> {
  const { find, repost, owner, log, signal } = options;
  const { pollMs = POLL_MS, repostMs = REPOST_MS } = options;
  let lastPost = Date.now();
  let lastRefused: number | undefined;
  while (!signal.aborted) {
    try {
      const land = await find();
      if (land?.owner === owner) return land;
      if (land && lastRefused !== land.landId) {
        lastRefused = land.landId;
        log(
          `Land ${land.landId} is owned by ${land.owner}, not by LAND_OWNER ${owner}: not serving it`,
        );
      }
    } catch (error) {
      log(`could not ask the Hub for the Land (${(error as Error).message})`);
    }
    await sleep(pollMs, signal);
    if (!signal.aborted && Date.now() - lastPost >= repostMs) {
      lastPost = Date.now();
      await repost().catch((error: unknown) =>
        log(`could not refresh the statement: ${(error as Error).message}`),
      );
    }
  }
  return undefined;
}
