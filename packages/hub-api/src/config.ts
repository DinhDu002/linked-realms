import { getAddress, isHex, type Address, type Hex } from "viem";

export interface Config {
  port: number;
  databaseUrl: string;
  rpcUrl: string;
  chainId: number;
  relayPublicUrl: string;
  relayInternalUrl: string;
  /** Signs Travel tickets: a server key that grants entry only and holds no assets. */
  ticketKey: Hex;
  sessionSecret: string;
  siweDomain: string;
  admins: Address[];
  allowedOrigins: string[];
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

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Reads and validates the environment; throws with a clear message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ticketKey = required(env, "HUB_TICKET_KEY");
  if (!isHex(ticketKey, { strict: true }) || ticketKey.length !== 66)
    throw new Error("HUB_TICKET_KEY must be a 0x-prefixed 32-byte hex key");
  const sessionSecret = required(env, "HUB_SESSION_SECRET");
  if (sessionSecret.length < 32)
    throw new Error("HUB_SESSION_SECRET must be at least 32 characters");
  const admins = list(env, "HUB_ADMINS").map((a) => {
    try {
      return getAddress(a);
    } catch {
      throw new Error(`HUB_ADMINS has an invalid address: "${a}"`);
    }
  });
  return {
    port: integer(env, "PORT", 8787, 1, 65535),
    databaseUrl: required(env, "DATABASE_URL"),
    rpcUrl: url(env, "RPC_URL", "http://127.0.0.1:8545"),
    chainId: integer(env, "CHAIN_ID", 31337, 1, Number.MAX_SAFE_INTEGER),
    relayPublicUrl: url(env, "RELAY_PUBLIC_URL", "http://127.0.0.1:8080"),
    relayInternalUrl: url(env, "RELAY_INTERNAL_URL", "http://127.0.0.1:8080"),
    ticketKey,
    sessionSecret,
    // SIWE messages must name this domain (the client's host[:port])
    siweDomain: env.HUB_SIWE_DOMAIN || "localhost:5173",
    admins,
    allowedOrigins: list(env, "HUB_ALLOWED_ORIGINS"),
  };
}
