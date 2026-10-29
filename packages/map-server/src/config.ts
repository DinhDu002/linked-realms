import { fileURLToPath } from "node:url";
import { isAddress } from "@linked-realms/core";
import { parseRelayUrl } from "@linked-realms/relay/agent";
import { isHost } from "@linked-realms/shared/identity";

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
  return {
    landOwner: address(env, "LAND_OWNER"),
    hubUrl,
    hubDomain,
    hubTicketSigner: optionalAddress(env, "HUB_TICKET_SIGNER"),
    mapServerKeyFile: env.MAP_SERVER_KEY_FILE || DEFAULT_KEY_FILE,
    port: integer(env, "PORT", 2567, 1, 65535),
    host: env.HOST || "127.0.0.1",
    relayUrl,
    mapFile: env.MAP_FILE || DEFAULT_MAP_FILE,
    landUiDir: env.LAND_UI_DIR || DEFAULT_LAND_UI_DIR,
  };
}
