import { fileURLToPath } from "node:url";
import { defaultMaxThreads } from "@linked-realms/miner";

export interface Config {
  landId: number;
  port: number;
  rpcUrl: string;
  chainId: number;
  mapFile: string;
  miningKeyFile: string;
  miningMaxThreads: number;
}

const DEFAULT_MAP_FILE = fileURLToPath(
  new URL("../../../maps/empty-land.json", import.meta.url),
);
// .data/ is gitignored at the repo root
const DEFAULT_MINING_KEY_FILE = fileURLToPath(
  new URL("../.data/mining-key", import.meta.url),
);

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number | undefined,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max)
    throw new Error(
      `${name} must be an integer in [${min}, ${max}], got "${raw}"`,
    );
  return value;
}

/** Reads and validates the environment; throws with a clear message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrl = env.RPC_URL || "http://127.0.0.1:8545";
  try {
    new URL(rpcUrl);
  } catch {
    throw new Error(`RPC_URL is not a valid URL: "${rpcUrl}"`);
  }
  return {
    // uint32 is the room state type of landId
    landId: integer(env, "LAND_ID", undefined, 1, 2 ** 32 - 1),
    port: integer(env, "PORT", 2567, 1, 65535),
    rpcUrl,
    chainId: integer(env, "CHAIN_ID", 31337, 1, Number.MAX_SAFE_INTEGER),
    mapFile: env.MAP_FILE || DEFAULT_MAP_FILE,
    miningKeyFile: env.MINING_KEY_FILE || DEFAULT_MINING_KEY_FILE,
    miningMaxThreads: integer(
      env,
      "MINING_MAX_THREADS",
      defaultMaxThreads(),
      1,
      256,
    ),
  };
}
