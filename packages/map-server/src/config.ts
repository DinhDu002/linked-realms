import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "@linked-realms/core";
import { parseRelayUrl } from "@linked-realms/relay/agent";
import { isHost } from "@linked-realms/shared/identity";
import type { NodeConfig } from "./node.ts";

export interface Config {
  /** The Character that owns this Land; the Hub's Land must name them. */
  landOwner: string;
  hubUrl: string;
  /** The Hub's host as statements name it (it can differ from `hubUrl` inside compose). */
  hubDomain: string;
  /** The address of the Hub's ticket key: a ticket's publicKey must hash to it. Unset: read from GET /keys. */
  hubTicketSigner: string | undefined;
  mapServerKeyFile: string;
  port: number;
  /** Interface to listen on: loopback by default, because the relay agent connects locally. */
  host: string;
  /** Unset: the relay the Hub publishes at GET /keys, if any. Without a relay the Land is reachable only directly. */
  relayUrl: string | undefined;
  mapFile: string;
  /** The built Land UI (`packages/client/dist`). */
  landUiDir: string;
  /** The Land's Node, or undefined with NODE_ENABLED=false (the Mine is then unavailable). */
  node: NodeConfig | undefined;
}

const DEFAULT_MAP_FILE = fileURLToPath(
  new URL("../../../maps/empty-land.json", import.meta.url),
);
// .data/ is gitignored at the repo root
const DEFAULT_KEY_FILE = fileURLToPath(
  new URL("../.data/map-server-key", import.meta.url),
);
const DEFAULT_LAND_UI_DIR = fileURLToPath(
  new URL("../../client/dist", import.meta.url),
);

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max)
    throw new Error(
      `${name} must be an integer in [${min}, ${max}], got "${raw}"`,
    );
  return value;
}

/** What the relay agent accepts (`parseRelayUrl`), checked at start instead of after registration. */
export function isRelayUrl(value: string): boolean {
  try {
    parseRelayUrl(value);
    return true;
  } catch {
    return false;
  }
}

function address(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalAddress(env, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalAddress(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name] || undefined;
  if (value !== undefined && !isAddress(value))
    throw new Error(`${name} is not an address: "${value}"`);
  return value;
}

const SEED = /^\S+:[1-9][0-9]{0,4}$/;

/** NODE_*: an external Node with its secret, else lr-node spawned in the key file's directory. */
function nodeConfig(
  env: NodeJS.ProcessEnv,
  mapServerKeyFile: string,
): NodeConfig | undefined {
  const enabled = env.NODE_ENABLED || "true";
  if (enabled !== "true" && enabled !== "false")
    throw new Error(`NODE_ENABLED must be true or false, got "${enabled}"`);
  if (enabled === "false") return undefined;
  // lr-node reads MINE_MAX_THREADS itself; checked here so a bad value fails now, not at each restart.
  integer(env, "MINE_MAX_THREADS", 1, 1, 4096);
  const controlUrl = env.NODE_CONTROL_URL || undefined;
  const secretFile = env.NODE_CONTROL_SECRET_FILE || undefined;
  if (controlUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(controlUrl);
    } catch {
      throw new Error(`NODE_CONTROL_URL is not a valid URL: "${controlUrl}"`);
    }
    if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol))
      throw new Error(
        `NODE_CONTROL_URL must be a ws://, wss://, http:// or https:// URL: "${controlUrl}"`,
      );
    if (!secretFile)
      throw new Error(
        "NODE_CONTROL_URL needs NODE_CONTROL_SECRET_FILE, the Node's control secret",
      );
    return { controlUrl, secretFile };
  }
  if (secretFile)
    throw new Error("NODE_CONTROL_SECRET_FILE is for NODE_CONTROL_URL");
  const network = env.NODE_NETWORK || "test";
  if (network !== "test" && network !== "dev")
    throw new Error(`NODE_NETWORK must be test or dev, got "${network}"`);
  const seeds = (env.NODE_SEEDS || "").split(",").filter((seed) => seed);
  for (const seed of seeds)
    if (!SEED.test(seed))
      throw new Error(`NODE_SEEDS holds HOST:PORT entries, got "${seed}"`);
  return {
    bin: env.NODE_BIN || "lr-node",
    network,
    dataDir: join(dirname(mapServerKeyFile), "lr-node"),
    seeds,
  };
}

/** Reads and validates the environment; throws with a clear message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hubUrl = env.HUB_URL || "http://localhost:8787";
  let hub: URL;
  try {
    hub = new URL(hubUrl);
  } catch {
    throw new Error(`HUB_URL is not a valid URL: "${hubUrl}"`);
  }
  if (hub.protocol !== "http:" && hub.protocol !== "https:")
    throw new Error(`HUB_URL must be an http:// or https:// URL: "${hubUrl}"`);
  const hubDomain = env.HUB_DOMAIN || hub.host;
  if (!isHost(hubDomain))
    throw new Error(`HUB_DOMAIN is not a host: "${hubDomain}"`);
  const relayUrl = env.RELAY_URL || undefined;
  if (relayUrl !== undefined && !isRelayUrl(relayUrl))
    throw new Error(
      `RELAY_URL must be a ws:// or wss:// URL with no path: "${relayUrl}"`,
    );
  const mapServerKeyFile = env.MAP_SERVER_KEY_FILE || DEFAULT_KEY_FILE;
  return {
    landOwner: address(env, "LAND_OWNER"),
    hubUrl,
    hubDomain,
    hubTicketSigner: optionalAddress(env, "HUB_TICKET_SIGNER"),
    mapServerKeyFile,
    port: integer(env, "PORT", 2567, 1, 65535),
    host: env.HOST || "127.0.0.1",
    relayUrl,
    mapFile: env.MAP_FILE || DEFAULT_MAP_FILE,
    landUiDir: env.LAND_UI_DIR || DEFAULT_LAND_UI_DIR,
    node: nodeConfig(env, mapServerKeyFile),
  };
}
