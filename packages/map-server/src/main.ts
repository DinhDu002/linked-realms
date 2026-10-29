import { existsSync, readFileSync } from "node:fs";
import { connectHost } from "@linked-realms/relay/agent";
import { parseLandMap } from "@linked-realms/shared";
import { loadConfig } from "./config.ts";
import {
  awaitLand,
  findLand,
  postStatement,
  registerMapServer,
} from "./hub.ts";
import { createLandServer } from "./land.ts";
import { loadOrCreateMapServerKey } from "./mapServerKey.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const mapText = readFileSync(config.mapFile, "utf8");
  const map = parseLandMap(mapText); // P6: validate even our own file
  const { key, created } = loadOrCreateMapServerKey(config.mapServerKeyFile);
  if (!existsSync(config.landUiDir))
    console.warn(
      `WARNING: LAND_UI_DIR ${config.landUiDir} does not exist: the Land UI will answer 503 (build it with "pnpm --filter @linked-realms/client build")`,
    );

  const server = createLandServer({
    map,
    mapText,
    hubTicketSigner: config.hubTicketSigner,
    landUiDir: config.landUiDir,
  });
  const stop = new AbortController();
  let host: { close(): Promise<void> } | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= (async () => {
      stop.abort();
      await host?.close();
      await server.close();
    })();
    return stopping;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      console.log(`${signal}: shutting down`);
      shutdown().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    });

  await server.listen(config.port, config.host);
  console.log(`Map server listening on http://${config.host}:${config.port}`);
  console.log(`Accepting Travel tickets signed by ${config.hubTicketSigner}`);

  const repost = () => postStatement(config, key, console.log);
  await registerMapServer(repost, console.log, stop.signal);
  console.log(
    [
      "",
      `Map server key ${created ? "created" : "loaded"}: ${key.address}`,
      `Next, the Land owner (${config.landOwner}) signs a Delegation for this Map server key under "Your Land" in the Shell.`,
      "Waiting for the Hub to create the Land...",
      "",
    ].join("\n"),
  );

  const land = await awaitLand({
    find: () => findLand(config, key.address),
    repost,
    owner: config.landOwner,
    log: console.log,
    signal: stop.signal,
  });
  if (!land) return; // shutting down
  server.setLand(land);
  console.log(`Serving Land ${land.landId} (owner ${land.owner})`);

  if (config.relayUrl) {
    host = connectHost({
      relayUrl: config.relayUrl,
      landId: land.landId,
      mapServerKey: key,
      localPort: config.port,
      log: console.log,
    });
    console.log(
      `Reachable through the relay at ${config.relayUrl} at ${land.url}, and directly on ${config.host}:${config.port}`,
    );
  } else {
    console.log(
      "RELAY_URL is not set: reachable only directly, not through the relay",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
