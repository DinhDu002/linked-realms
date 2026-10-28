import { readFileSync } from "node:fs";
import {
  Miner,
  createMinerChain,
  loadOrCreateMiningKey,
} from "@linked-realms/miner";
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
    chain,
    mining,
  });
  // Workers must not outlive the server, even if the process is slow to exit.
  server.onShutdown(() => mining.stop());
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
