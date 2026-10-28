// Row builders kept free of Ponder so Vitest can test them directly.
import { bytes32ToStatKey } from "@linked-realms/shared";
import type { Address, Hex } from "viem";

export interface BlockRef {
  number: bigint;
  timestamp: bigint;
}

export function characterRow(player: Address, landId: bigint, block: BlockRef) {
  return {
    player,
    landId,
    createdAtBlock: block.number,
    createdAtTimestamp: block.timestamp,
  };
}

export function statRow(player: Address, key: Hex, value: bigint) {
  return { player, key: bytes32ToStatKey(key), value };
}

export function landRow(
  id: bigint,
  owner: Address,
  x: number,
  y: number,
  block: BlockRef,
) {
  return {
    id,
    owner,
    x,
    y,
    mintedAtBlock: block.number,
    mintedAtTimestamp: block.timestamp,
  };
}
