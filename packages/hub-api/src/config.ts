import type { BlockList } from "node:net";
import { isAddress } from "@linked-realms/core";
import { isHost } from "@linked-realms/shared/identity";
import { trustedProxies } from "./network.ts";

export interface Config {
  port: number;
  databaseUrl: string;
  relayInternalUrl: string;
  /** The relay as Map servers dial it, published by GET /keys; null when this world has none. */
  relayPublicUrl: string | null;
  /** The `Hub:` line of every statement: this Hub's host. */
  hubDomain: string;
  /** Seed of the key that signs Travel tickets: it grants entry only and holds no assets. */
  ticketSeed: Uint8Array;
  sessionSecret: string;
  admins: string[];
  allowedOrigins: string[];
  /** Lands are served at `<landUrlScheme>://<landId>.<landBaseDomain>`. */
  landBaseDomain: string;
  landUrlScheme: "http" | "https";
  trustedProxies: BlockList;
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

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name] || fallback;
  try {
    new URL(value);
  } catch {
    // never echo the value: URLs can carry credentials
    throw new Error(`${name} is not a valid URL`);
  }
  return value.replace(/\/+$/, "");
}

function wsUrl(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  // as the relay agent requires (parseRelayUrl in @linked-realms/relay/agent)
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.pathname.replace(/\/+$/, "") !== "" ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be a ws:// or wss:// URL with no path`);
  return value.replace(/\/+$/, "");
}

function host(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  const value = env[name] || fallback;
  if (!isHost(value))
    throw new Error(
      `${name} must be a lowercase host with an optional port, got "${value}"`,
    );
  return value;
}

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Reads and validates the environment; throws with a clear message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ticketKey = required(env, "HUB_TICKET_KEY");
  // never echo the value: it is a secret
  if (!/^[0-9a-f]{64}$/i.test(ticketKey))
    throw new Error("HUB_TICKET_KEY must be a 32-byte seed in hex");
  const sessionSecret = required(env, "HUB_SESSION_SECRET");
  if (sessionSecret.length < 32)
    throw new Error("HUB_SESSION_SECRET must be at least 32 characters");
  const admins = list(env, "HUB_ADMINS");
  for (const a of admins)
    if (!isAddress(a))
      throw new Error(`HUB_ADMINS has an invalid address: "${a}"`);
  const scheme = env.LAND_URL_SCHEME || "http";
  if (scheme !== "http" && scheme !== "https")
    throw new Error(`LAND_URL_SCHEME must be http or https, got "${scheme}"`);
  return {
    port: integer(env, "PORT", 8787, 1, 65535),
    databaseUrl: required(env, "DATABASE_URL"),
    relayInternalUrl: url(env, "RELAY_INTERNAL_URL", "http://127.0.0.1:8080"),
    relayPublicUrl: wsUrl(env, "RELAY_PUBLIC_URL"),
    hubDomain: host(env, "HUB_DOMAIN", "localhost:8787"),
    ticketSeed: Uint8Array.from(Buffer.from(ticketKey, "hex")),
    sessionSecret,
    admins,
    allowedOrigins: list(env, "HUB_ALLOWED_ORIGINS"),
    landBaseDomain: host(env, "LAND_BASE_DOMAIN", "localhost:8080"),
    landUrlScheme: scheme,
    trustedProxies: trustedProxies(list(env, "HUB_TRUSTED_PROXIES")),
  };
}
