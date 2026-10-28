import { formatUnits, type Address } from "viem";

/** `0x1234…abcd`, for labels. */
export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface Stat {
  key: string;
  value: bigint;
}

/** `[key, value]` rows for the stats table, in contract order. */
export function statRows(stats: Stat[]): Array<[string, string]> {
  return stats.map((s) => [s.key, s.value.toString()]);
}

/** Gold has 18 decimals; formatUnits avoids float rounding. */
export function formatGold(wei: bigint): string {
  return `${formatUnits(wei, 18)} GOLD`;
}
