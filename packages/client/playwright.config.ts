import { defineConfig, devices } from "@playwright/test";

// The Land UI in a real browser (e2e/): the reference Map server with a Node the test drives, in a
// stub Shell. `pnpm --filter @linked-realms/client test:browser` builds the page first.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
