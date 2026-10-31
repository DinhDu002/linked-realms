import { loadConfig } from "./config.ts";
import { createDashboardServer } from "./server.ts";

try {
  const config = loadConfig();
  const server = createDashboardServer(config);
  // The URLs are not logged: they can carry credentials.
  server.listen(config.port, () =>
    console.log(
      `dashboard on :${config.port}` + (config.hubUrl ? "" : " (no Hub)"),
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => server.close(() => process.exit(0)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
