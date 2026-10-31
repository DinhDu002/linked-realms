// Fixed when the Shell is built (.env.example).
const DEFAULT_HUB_URL = "http://localhost:8787";
const DEFAULT_LAND_IMAGE = "ghcr.io/dinhdu002/linked-realms-node:latest";
const DEFAULT_NODE_URL = "http://localhost:9445";

/** LR's networks by the names `lr-node --network` takes (crates/core/test-vectors/chain.json). */
export const NETWORK_IDS = { test: 1, dev: 2 } as const;

/** The id of the network named `name`; throws for one the Shell does not know. */
export function networkIdOf(name: string): number {
  if (!Object.hasOwn(NETWORK_IDS, name))
    throw new Error(`This Shell was built for an unknown network: ${name}`);
  return NETWORK_IDS[name as keyof typeof NETWORK_IDS];
}

/** The `Hub` line of a statement: the host of the Hub's URL, with its port if it is not the default. */
export function hubHostOf(hubUrl: string): string {
  return new URL(hubUrl).host;
}

export const hubUrl = (
  (import.meta.env.VITE_HUB_URL as string | undefined) || DEFAULT_HUB_URL
).replace(/\/+$/, "");
export const hubHost = hubHostOf(hubUrl);
// ponytail: the Public node is fixed when the Shell is built, so the CSP can name it. A Node the
// Player chooses (ADR 0006 decision 10) needs a wider connect-src; it waits on the project owner.
export const nodeUrl = (
  (import.meta.env.VITE_NODE_URL as string | undefined) || DEFAULT_NODE_URL
).replace(/\/+$/, "");
/** The network the Shell signs for: a Node on another one is refused. */
export const network =
  (import.meta.env.VITE_NETWORK as string | undefined) || "test";
export const landImage =
  (import.meta.env.VITE_LAND_IMAGE as string | undefined) || DEFAULT_LAND_IMAGE;

/**
 * The one line a Land owner runs to start a Map server for `owner`. It needs no quoting, so it
 * pastes the same into sh, zsh, bash and PowerShell. The volume keeps the Map server key.
 */
export function landCommand(owner: string, hub: string, image: string): string {
  return `docker run -d --name linked-realms-land --restart unless-stopped -v linked-realms-land:/data -e LAND_OWNER=${owner} -e HUB_URL=${hub} ${image}`;
}
