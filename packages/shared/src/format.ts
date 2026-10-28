// Display formats shared by the client and the indexer's dashboard.

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
