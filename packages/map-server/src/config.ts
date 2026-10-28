import { fileURLToPath } from "node:url";
import { defaultMaxThreads } from "@linked-realms/miner";
import { isAddress, type Address } from "viem";

export interface Config {
  landId: number;
  port: number;
  /** Interface to listen on: loopback by default, because the relay agent connects locally. */
  host: string;
  /** Without it the Land is reachable only directly (development). */
  relayUrl: string | undefined;
  /** The Hub address whose Travel tickets this server accepts. */
  hubTicketSigner: Address;
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
  const relayUrl = env.RELAY_URL || undefined;
  if (relayUrl !== undefined && !/^wss?:\/\//.test(relayUrl))
    throw new Error(`RELAY_URL must be a ws:// or wss:// URL: "${relayUrl}"`);
  const signer = env.HUB_TICKET_SIGNER;
  if (!signer) throw new Error("HUB_TICKET_SIGNER is required");
  if (!isAddress(signer, { strict: false }))
    throw new Error(`HUB_TICKET_SIGNER is not an address: "${signer}"`);
  return {
    // uint32 is the room state type of landId
    landId: integer(env, "LAND_ID", undefined, 1, 2 ** 32 - 1),
    port: integer(env, "PORT", 2567, 1, 65535),
    host: env.HOST || "127.0.0.1",
    relayUrl,
    hubTicketSigner: signer,
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
