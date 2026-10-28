import { loadConfig } from "./config.ts";
import { createRelay } from "./relay.ts";

try {
  const config = loadConfig();
  const relay = createRelay(config);
  relay.listen(config.port, () =>
    console.log(`relay listening on :${config.port}, Hub at ${config.hubUrl}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => relay.close(() => process.exit(0)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
