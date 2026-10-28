import { hexToString, stringToHex, type Hex } from "viem";

/** Stat keys are ASCII left-aligned in a bytes32, like Solidity's `bytes32("strength")`. */
export function statKeyToBytes32(key: string): Hex {
  return stringToHex(key, { size: 32 });
}

export function bytes32ToStatKey(value: Hex): string {
  return hexToString(value, { size: 32 });
}
