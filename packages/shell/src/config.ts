// Fixed when the Shell is built (.env.example).
const DEFAULT_HUB_URL = "http://localhost:8787";
const DEFAULT_LAND_IMAGE = "ghcr.io/dinhdu002/linked-realms-node:latest";

/** The `Hub` line of a statement: the host of the Hub's URL, with its port if it is not the default. */
export function hubHostOf(hubUrl: string): string {
  return new URL(hubUrl).host;
}

export const hubUrl = (
  (import.meta.env.VITE_HUB_URL as string | undefined) || DEFAULT_HUB_URL
).replace(/\/+$/, "");
export const hubHost = hubHostOf(hubUrl);
export const landImage =
  (import.meta.env.VITE_LAND_IMAGE as string | undefined) || DEFAULT_LAND_IMAGE;

/**
 * The one line a Land owner runs to start a Map server for `owner`. It needs no quoting, so it
 * pastes the same into sh, zsh, bash and PowerShell. The volume keeps the Map server key.
 */
export function landCommand(owner: string, hub: string, image: string): string {
  return `docker run -d --name linked-realms-land --restart unless-stopped -v linked-realms-land:/data -e LAND_OWNER=${owner} -e HUB_URL=${hub} ${image}`;
}
