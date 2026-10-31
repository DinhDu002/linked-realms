import { existsSync, readFileSync } from "node:fs";
import { connectHost } from "@linked-realms/relay/agent";
import { parseLandMap } from "@linked-realms/shared";
import { loadConfig } from "./config.ts";
import {
  awaitLand,
  fetchWorld,
  findLand,
  postStatement,
  retry,
} from "./hub.ts";
import { createLandServer, type LandServer } from "./land.ts";
import { loadOrCreateMapServerKey } from "./mapServerKey.ts";
import { mineLine } from "./mine.ts";
import { startNode, type MineStatus } from "./node.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const mapText = readFileSync(config.mapFile, "utf8");
  const map = parseLandMap(mapText); // P6: validate even our own file
  const { key, created } = loadOrCreateMapServerKey(config.mapServerKeyFile);
  if (!existsSync(config.landUiDir))
    console.warn(
      `WARNING: LAND_UI_DIR ${config.landUiDir} does not exist: the Land UI will answer 503 (build it with "pnpm --filter @linked-realms/client build")`,
    );

  const node = config.node && startNode(config.node, console.log);
  if (!config.node)
    console.log("NODE_ENABLED=false: no Node, so the Mine is unavailable");
  let mine: MineStatus | undefined;
  node?.link.onChange(() => {
    const line = mineLine(mine, node.link.status());
    mine = node.link.status();
    if (line) console.log(line);
  });

  const stop = new AbortController();
  let server: LandServer | undefined = undefined; // set once the Hub has answered
  let host: { close(): Promise<void> } | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    stopping ??= (async () => {
      stop.abort();
      await host?.close();
      await server?.close();
      await node?.close();
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

  // Unset HUB_TICKET_SIGNER or RELAY_URL: take what the Hub publishes (ADR 0010).
  const world =
    config.hubTicketSigner && config.relayUrl
      ? undefined
      : await retry(
          () => fetchWorld(config),
          `read GET /keys from the Hub at ${config.hubUrl}`,
          console.log,
          stop.signal,
        );
  if (stop.signal.aborted) return;
  const hubTicketSigner = config.hubTicketSigner ?? world!.ticketSigner;
  const relayUrl = config.relayUrl ?? world?.relayUrl;

  server = createLandServer({
    map,
    mapText,
    hubTicketSigner,
    landUiDir: config.landUiDir,
    mapServerKey: key.address,
    node: node?.link,
  });
  await server.listen(config.port, config.host);
  console.log(`Map server listening on http://${config.host}:${config.port}`);
  console.log(
    `Accepting Travel tickets signed by ${hubTicketSigner} (${config.hubTicketSigner ? "HUB_TICKET_SIGNER" : "from the Hub"})`,
  );

  const repost = () => postStatement(config, key, console.log);
  await retry(repost, "register with the Hub", console.log, stop.signal);
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

  if (relayUrl) {
    host = connectHost({
      relayUrl,
      landId: land.landId,
      mapServerKey: key,
      localPort: config.port,
      log: console.log,
    });
    console.log(
      `Reachable through the relay at ${relayUrl} at ${land.url}, and directly on ${config.host}:${config.port}`,
    );
  } else {
    console.log(
      `No relay (RELAY_URL is not set and the Hub publishes none): reachable only directly on ${config.host}:${config.port}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
