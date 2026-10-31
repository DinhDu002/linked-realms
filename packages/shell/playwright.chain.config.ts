import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { HUB_PORT, HUB_URL, SHELL_ORIGIN, SHELL_PORT } from "./e2e/ports.ts";
import { MINER, NODE_PORT, NODE_URL } from "./e2e-chain/node.ts";

// Gold end to end (e2e-chain/): a Shell built for the dev network sends Gold through a real
// `lr-node` that mines for the first Character. Local only, like e2e-world: it builds lr-node and
// mines on this machine's CPU while it runs. Run with `pnpm e2e:chain`.
const threads = Math.max(1, availableParallelism() - 2);

export default defineConfig({
  testDir: "e2e-chain",
  reporter: [["list"]],
  use: { baseURL: SHELL_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: [
    {
      command: "node e2e/servers.ts",
      url: `http://localhost:${HUB_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      // A fresh dev chain each run; `exec` leaves lr-node as the process Playwright stops.
      command:
        `cargo build --release -q -p linked-realms-node --bin lr-node && ` +
        `exec ../../target/release/lr-node --network dev --data "$(mktemp -d)" ` +
        `--rpc 127.0.0.1:${NODE_PORT} mine --reward-address ${MINER.address} ` +
        `--threads ${threads} --mode light`,
      port: NODE_PORT,
      reuseExistingServer: false,
      timeout: 600_000,
    },
    {
      command: `pnpm vite build && pnpm vite preview --port ${SHELL_PORT}`,
      url: SHELL_ORIGIN,
      env: {
        VITE_HUB_URL: HUB_URL,
        VITE_NODE_URL: NODE_URL,
        VITE_NETWORK: "dev",
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
