// Reads GOLD balance and Rounds won from the chain.
import {
  deploymentFor,
  goldMineAbi,
  goldTokenAbi,
} from "@linked-realms/shared";
import type { Address, PublicClient } from "viem";

export interface RoundWon {
  round: bigint;
  reward: bigint;
  blockNumber: bigint;
}

export async function goldBalance(
  reader: PublicClient,
  chainId: number,
  player: Address,
): Promise<bigint> {
  return reader.readContract({
    address: deploymentFor(chainId).GoldToken.address,
    abi: goldTokenAbi,
    functionName: "balanceOf",
    args: [player],
  });
}

/** Rounds whose reward went to `player`, newest first. */
export async function roundsWon(
  reader: PublicClient,
  chainId: number,
  player: Address,
): Promise<RoundWon[]> {
  const { GoldMine } = deploymentFor(chainId);
  const logs = await reader.getContractEvents({
    address: GoldMine.address,
    abi: goldMineAbi,
    eventName: "RoundWon",
    args: { rewardWallet: player },
    fromBlock: BigInt(GoldMine.startBlock),
  });
  return logs
    .map((l) => ({
      round: l.args.round ?? 0n,
      reward: l.args.reward ?? 0n,
      blockNumber: l.blockNumber,
    }))
    .sort((a, b) => (a.round < b.round ? 1 : a.round > b.round ? -1 : 0));
}
