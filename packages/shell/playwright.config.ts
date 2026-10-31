import { defineConfig, devices } from "@playwright/test";
import {
  HUB_PORT,
  HUB_URL,
  NODE_URL,
  SHELL_ORIGIN,
  SHELL_PORT,
} from "./e2e/ports.ts";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: SHELL_ORIGIN, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
  ],
  webServer: [
    {
      command: "node e2e/servers.ts",
      url: `http://localhost:${HUB_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      // The Hub's and the Node's URLs are fixed when the Shell is built.
      command: `pnpm vite build && pnpm vite preview --port ${SHELL_PORT}`,
      url: SHELL_ORIGIN,
      env: { VITE_HUB_URL: HUB_URL, VITE_NODE_URL: NODE_URL },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
