import { isHost } from "@linked-realms/shared/identity";
import { MAX_DATA_PAYLOAD } from "./protocol.ts";

export interface Config {
  port: number;
  hubUrl: string;
  /** This relay's host as Map servers dial it; a hello must name it. */
  relayHost: string;
  /** Lands are served at `<landId>.<landBaseDomain>`. */
  landBaseDomain: string;
  /** Origins allowed to frame a Land (`frame-ancestors`). */
  shellOrigins: string[];
  maxClientsPerLand: number;
  maxHosts: number;
  /** Largest frame a Player may send. */
  playerMaxFrame: number;
}

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

function host(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name] || "localhost:8080";
  if (!isHost(value))
    throw new Error(
      `${name} must be a lowercase host name with an optional port, got "${value}"`,
    );
  return value;
}

function origins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((part) => {
    const origin = part.trim();
    let url: URL | undefined;
    try {
      url = new URL(origin);
    } catch {
      // reported below
    }
    if (
      !url ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== origin
    )
      throw new Error(
        `SHELL_ORIGINS must list http(s) origins without a path, got "${origin}"`,
      );
    return origin;
  });
}

/** Reads and validates the environment; throws with a clear message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hubUrl = env.HUB_URL;
  if (!hubUrl) throw new Error("HUB_URL is required");
  let protocol: string;
  try {
    protocol = new URL(hubUrl).protocol;
  } catch {
    throw new Error(`HUB_URL is not a valid URL: "${hubUrl}"`);
  }
  if (protocol !== "http:" && protocol !== "https:")
    throw new Error(`HUB_URL must be http(s), got "${hubUrl}"`);
  return {
    port: integer(env, "PORT", 8080, 0, 65535),
    hubUrl,
    relayHost: host(env, "RELAY_HOST"),
    landBaseDomain: host(env, "LAND_BASE_DOMAIN"),
    shellOrigins: origins(env.SHELL_ORIGINS),
    maxClientsPerLand: integer(env, "MAX_CLIENTS_PER_LAND", 64, 1, 100_000),
    maxHosts: integer(env, "MAX_HOSTS", 1000, 1, 100_000),
    playerMaxFrame: integer(
      env,
      "PLAYER_MAX_FRAME",
      16 * 1024,
      1,
      MAX_DATA_PAYLOAD,
    ),
  };
}
