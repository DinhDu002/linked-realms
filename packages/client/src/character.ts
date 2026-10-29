// Reads and writes the Character and Land contracts.
import {
  bytes32ToStatKey,
  deploymentFor,
  landAbi,
  playerRegistryAbi,
} from "@linked-realms/shared";
import { encodeFunctionData, type Address, type PublicClient } from "viem";
import type { Stat } from "./format.ts";
import type { Wallet } from "./wallet.ts";

export interface CharacterView {
  stats: Stat[];
  landId: bigint;
  x: number;
  y: number;
}

export async function hasCharacter(
  reader: PublicClient,
  chainId: number,
  player: Address,
): Promise<boolean> {
  return reader.readContract({
    address: deploymentFor(chainId).PlayerRegistry.address,
    abi: playerRegistryAbi,
    functionName: "hasCharacter",
    args: [player],
  });
}

export async function loadCharacter(
  reader: PublicClient,
  chainId: number,
  player: Address,
): Promise<CharacterView> {
  const { PlayerRegistry, Land } = deploymentFor(chainId);
  const keys = await reader.readContract({
    address: PlayerRegistry.address,
    abi: playerRegistryAbi,
    functionName: "statKeys",
  });
  const values = await Promise.all(
    keys.map((key) =>
      reader.readContract({
        address: PlayerRegistry.address,
        abi: playerRegistryAbi,
        functionName: "statOf",
        args: [player, key],
      }),
    ),
  );
  const landId = await reader.readContract({
    address: Land.address,
    abi: landAbi,
    functionName: "landOf",
    args: [player],
  });
  const [x, y] = await reader.readContract({
    address: Land.address,
    abi: landAbi,
    functionName: "coordinatesOf",
    args: [landId],
  });
  return {
    stats: keys.map((key, i) => ({
      key: bytes32ToStatKey(key),
      value: values[i] ?? 0n,
    })),
    landId,
    x,
    y,
  };
}

/** Sends createCharacter() and waits until it is mined. */
export function createCharacter(
  chainId: number,
  wallet: Wallet,
): Promise<void> {
  return wallet.send({
    to: deploymentFor(chainId).PlayerRegistry.address,
    data: encodeFunctionData({
      abi: playerRegistryAbi,
      functionName: "createCharacter",
    }),
  });
}
