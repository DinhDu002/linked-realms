/** A hash rate as the Land UI and the dashboard write it: H/s, kH/s or MH/s. */
export function hashRateText(perSecond: number): string {
  if (perSecond >= 1e6) return `${(perSecond / 1e6).toFixed(1)} MH/s`;
  if (perSecond >= 1e3) return `${(perSecond / 1e3).toFixed(1)} kH/s`;
  return `${Math.round(perSecond)} H/s`;
}
