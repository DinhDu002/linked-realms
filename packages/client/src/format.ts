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

const RATE_UNITS = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s"];

/** `850 H/s`, `3.34 MH/s` (two decimals, trailing zeros dropped). */
export function formatHashRate(hashRate: number): string {
  let value = Math.max(0, hashRate);
  let unit = 0;
  while (value >= 1000 && unit < RATE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const text = unit === 0 ? Math.round(value) : Number(value.toFixed(2));
  return `${text} ${RATE_UNITS[unit]}`;
}
