export interface Config {
  port: number;
  hubUrl: string;
  maxClientsPerLand: number;
  maxHosts: number;
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
    maxClientsPerLand: integer(env, "MAX_CLIENTS_PER_LAND", 64, 1, 100_000),
    maxHosts: integer(env, "MAX_HOSTS", 1000, 1, 100_000),
  };
}
