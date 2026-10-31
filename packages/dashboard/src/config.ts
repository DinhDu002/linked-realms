export interface Config {
  port: number;
  /** The Public node's RPC (docs/protocols/node-rpc.md). */
  nodeUrl: string;
  /** The Hub, for its Directory; without it Lands online is unknown and Lands are not named. */
  hubUrl: string | undefined;
}

function url(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  // never echo the value: URLs can carry credentials
  if (url?.protocol !== "http:" && url?.protocol !== "https:")
    throw new Error(`${name} is not a valid http or https URL`);
  // fetch refuses such a URL, and its error would put them in the log
  if (url.username || url.password)
    throw new Error(`${name} must not carry credentials`);
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT || "8790";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error(`PORT must be an integer in [1, 65535], got "${port}"`);
  const nodeUrl = url(env, "NODE_RPC_URL");
  if (!nodeUrl) throw new Error("NODE_RPC_URL is required");
  return { port: Number(port), nodeUrl, hubUrl: url(env, "HUB_URL") };
}
