import { serve } from "@hono/node-server";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  deploymentFor,
  landAbi,
  playerRegistryAbi,
} from "@linked-realms/shared";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";

const config = loadConfig();
const log = (message: string) => console.error(`hub-api: ${message}`);
const db = createPool(config.databaseUrl, log);
await migrate(db);

const client = createPublicClient({ transport: http(config.rpcUrl) });
const bundlerUrl = config.bundlerUrl;
const deployment = deploymentFor(config.chainId);

/** A reverted call means "no such Land"; any other failure (RPC down) is rethrown. */
async function orMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (
      err instanceof BaseError &&
      err.walk((e) => e instanceof ContractFunctionRevertedError)
    )
      return undefined;
    throw err;
  }
}

const app = createApp({
  config,
  db,
  chain: {
    ownerOf: (landId) =>
      orMissing(() =>
        client.readContract({
          address: deployment.Land.address,
          abi: landAbi,
          functionName: "ownerOf",
          args: [landId],
        }),
      ),
    coordinatesOf: async (landId) => {
      const xy = await orMissing(() =>
        client.readContract({
          address: deployment.Land.address,
          abi: landAbi,
          functionName: "coordinatesOf",
          args: [landId],
        }),
      );
      return xy && { x: xy[0], y: xy[1] };
    },
    hasCharacter: (player) =>
      client.readContract({
        address: deployment.PlayerRegistry.address,
        abi: playerRegistryAbi,
        functionName: "hasCharacter",
        args: [player],
      }),
  },
  verifySiwe: (args) => client.verifySiweMessage(args),
  verifyTypedData: (args) => client.verifyTypedData(args),
  online: async () => {
    const res = await fetch(`${config.relayInternalUrl}/online`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`relay /online answered ${res.status}`);
    const body = (await res.json()) as { lands?: unknown };
    if (
      !Array.isArray(body.lands) ||
      !body.lands.every((n) => Number.isInteger(n))
    )
      throw new Error("relay /online returned an unexpected body");
    return body.lands as number[];
  },
  ticketSigner: privateKeyToAccount(config.ticketKey),
  bundler: bundlerUrl
    ? async (request) => {
        const res = await fetch(bundlerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`bundler answered ${res.status}`);
        const body: unknown = await res.json();
        if (typeof body !== "object" || body === null)
          throw new Error("bundler returned an unexpected body");
        return body;
      }
    : undefined,
  now: Date.now,
  log,
});

serve({ fetch: app.fetch, port: config.port }, (info) =>
  console.log(`hub-api listening on :${info.port}`),
);
