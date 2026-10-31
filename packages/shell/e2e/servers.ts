// Starts the Hub stub, the Node stub and the hostile Land for Playwright's `webServer`.
import { startHubStub } from "./hub-stub.ts";
import { startLandServer } from "./land-server.ts";
import { startNodeStub } from "./node-stub.ts";

await startHubStub();
await startLandServer();
await startNodeStub();
console.log("e2e servers ready");
setInterval(() => {}, 1 << 30); // stay up until Playwright stops us
