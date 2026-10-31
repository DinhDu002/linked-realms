import { defineConfig, devices } from "@playwright/test";

// The world end to end (e2e-world/): the stack must already run (compose.yaml, profile `world`).
export default defineConfig({
  testDir: "e2e-world",
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${process.env.SHELL_PORT || "8788"}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
