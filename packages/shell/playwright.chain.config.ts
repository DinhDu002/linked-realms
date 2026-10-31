import { defineConfig, devices } from "@playwright/test";

// Gold end to end (e2e-chain/): the stack must already run (compose.yaml, profile `world`).
export default defineConfig({
  testDir: "e2e-chain",
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${process.env.SHELL_PORT || "8788"}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
