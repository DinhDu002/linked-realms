// Starts the Hub stub and the hostile Land for Playwright's `webServer`.
import { startHubStub } from "./hub-stub.ts";
import { startLandServer } from "./land-server.ts";

await startHubStub();
await startLandServer();
console.log("e2e servers ready");
setInterval(() => {}, 1 << 30); // stay up until Playwright stops us
