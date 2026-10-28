import { readFileSync } from "node:fs";
import {
  Miner,
  createMinerChain,
  loadOrCreateMiningKey,
} from "@linked-realms/miner";
import { connectHost } from "@linked-realms/relay/agent";
import { parseLandMap } from "@linked-realms/shared";
import { createPublicClient, http, numberToHex } from "viem";
import { createChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { reportMiningKey } from "./miningKey.ts";
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

  // P2: the Mining key only pays fees; rewards go to the Land owner.
  const key = loadOrCreateMiningKey(config.miningKeyFile);
  const mining = new Miner({
    chain: createMinerChain({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      privateKey: key.privateKey,
    }),
    rewardWallet: land.owner,
    maxThreads: config.miningMaxThreads,
    log: console.log,
  });
  const rpc = createPublicClient({ transport: http(config.rpcUrl) });
  await reportMiningKey(
    {
      getChainId: () => rpc.getChainId(),
      getBalance: (args) => rpc.getBalance(args),
      setBalance: async (address, wei) => {
        await rpc.request({
          method: "anvil_setBalance" as never,
          params: [address, numberToHex(wei)] as never,
        });
      },
    },
    config.chainId,
    key.address,
    key.created,
  );

  const server = createServer({
    landId: config.landId,
    map,
    mapText,
    land,
    hubSigner: config.hubTicketSigner,
    chainId: config.chainId,
    mining,
  });
  // Workers must not outlive the server, even if the process is slow to exit.
  server.onShutdown(() => mining.stop());
  await server.listen(config.port, config.host);
  console.log(
    `Map server for Land ${config.landId} (owner ${land.owner}) at ws://${config.host}:${config.port}`,
  );
  console.log(`Accepting Travel tickets signed by ${config.hubTicketSigner}`);
  if (config.relayUrl) {
    const host = connectHost({
      relayUrl: config.relayUrl,
      landId: config.landId,
      privateKey: key.privateKey,
      localPort: config.port,
      log: console.log,
    });
    server.onShutdown(() => host.close());
    console.log(
      `Reachable through the relay at ${config.relayUrl} (once the Land owner registers the Mining key with the Hub), and directly on ${config.host}:${config.port}`,
    );
  } else {
    console.log(
      "RELAY_URL is not set: reachable only directly, not through the relay",
    );
  }
  // Colyseus handles SIGINT/SIGTERM itself (gracefullyShutdown defaults to true).
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
