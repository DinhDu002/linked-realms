import { readFileSync } from "node:fs";
import { parseLandMap } from "@linked-realms/shared";
import { createChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const mapText = readFileSync(config.mapFile, "utf8");
  const map = parseLandMap(mapText); // P6: validate even our own file
  const chain = createChain(config.rpcUrl, config.chainId);
  const land = await chain.landInfo(config.landId).catch((cause: unknown) => {
    throw new Error(
      `Land ${config.landId} not found on chain ${config.chainId}`,
      {
        cause,
      },
    );
  });

  const server = createServer({
    landId: config.landId,
    map,
    mapText,
    land,
    chain,
  });
  await server.listen(config.port);
  console.log(
    `Map server for Land ${config.landId} (owner ${land.owner}) at ws://localhost:${config.port}`,
  );
  // Colyseus handles SIGINT/SIGTERM itself (gracefullyShutdown defaults to true).
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
