import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { deploymentFor, landAbi } from "@linked-realms/shared";

export interface LandInfo {
  owner: Address;
  x: number;
  y: number;
}

/** What the Map server needs from the chain at start-up. Tests use a fake. */
export interface Chain {
  /** Rejects when the Land does not exist. */
  landInfo(landId: number): Promise<LandInfo>;
}

export function createChain(rpcUrl: string, chainId: number): Chain {
  const { Land } = deploymentFor(chainId);
  const client: PublicClient = createPublicClient({ transport: http(rpcUrl) });
  return {
    async landInfo(landId) {
      const id = BigInt(landId);
      const [owner, [x, y]] = await Promise.all([
        client.readContract({
          address: Land.address,
          abi: landAbi,
          functionName: "ownerOf",
          args: [id],
        }),
        client.readContract({
          address: Land.address,
          abi: landAbi,
          functionName: "coordinatesOf",
          args: [id],
        }),
      ]);
      return { owner, x, y };
    },
  };
}
