// Fixed when the Shell is built (.env.example).
const DEFAULT_HUB_URL = "http://localhost:8787";

/** The `Hub` line of a statement: the host of the Hub's URL, with its port if it is not the default. */
export function hubHostOf(hubUrl: string): string {
  return new URL(hubUrl).host;
}

export const hubUrl = (
  (import.meta.env.VITE_HUB_URL as string | undefined) || DEFAULT_HUB_URL
).replace(/\/+$/, "");
export const hubHost = hubHostOf(hubUrl);
