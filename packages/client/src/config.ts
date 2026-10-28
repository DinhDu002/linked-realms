// Vite env → validated config. Pure so it can be tested without a browser.

export interface ClientConfig {
  rpcUrl: string;
  chainId: number;
  mapServerUrl: string;
  landId: number;
}

type Env = Record<string, unknown>;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return typeof v === "string" && v !== "" ? v : fallback;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = str(env, key, String(fallback));
  if (
    !/^\d+$/.test(raw) ||
    Number(raw) < 1 ||
    !Number.isSafeInteger(Number(raw))
  )
    throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return Number(raw);
}

function url(env: Env, key: string, fallback: string, protocols: string[]) {
  const raw = str(env, key, fallback);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be a URL, got "${raw}"`);
  }
  if (!protocols.includes(parsed.protocol))
    throw new Error(`${key} must use ${protocols.join(" or ")}, got "${raw}"`);
  return raw;
}

export function parseConfig(env: Env): ClientConfig {
  return {
    rpcUrl: url(env, "VITE_RPC_URL", "http://127.0.0.1:8545", [
      "http:",
      "https:",
    ]),
    chainId: positiveInt(env, "VITE_CHAIN_ID", 31337),
    mapServerUrl: url(env, "VITE_MAP_SERVER_URL", "ws://127.0.0.1:2567", [
      "ws:",
      "wss:",
    ]),
    landId: positiveInt(env, "VITE_LAND_ID", 1),
  };
}

/** The local dev wallet is only offered on the local anvil chain. */
export const DEV_CHAIN_ID = 31337;
