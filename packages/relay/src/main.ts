import { loadConfig } from "./config.ts";
import { createRelay } from "./relay.ts";

try {
  const config = loadConfig();
  const relay = createRelay(config);
  relay.listen(config.port, () =>
    console.log(
      `relay ${config.relayHost} listening on :${config.port}, Lands at *.${config.landBaseDomain}, Hub at ${config.hubUrl}`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => relay.close(() => process.exit(0)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
