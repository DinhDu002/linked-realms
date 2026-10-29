// Fixed ports of the browser tests: the Hub's URL is baked into the Shell at build time.
export const SHELL_PORT = 4182;
export const HUB_PORT = 8791;
export const LAND_PORT = 8792;

export const SHELL_ORIGIN = `http://localhost:${SHELL_PORT}`;
export const HUB_URL = `http://localhost:${HUB_PORT}`;
export const landOrigin = (landId: number) =>
  `http://${landId}.localhost:${LAND_PORT}`;
