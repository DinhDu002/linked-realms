/** Time constant of the smoothing; a little over one server tick (50 ms at 20 Hz). */
export const SMOOTHING_MS = 80;
const SNAP_DISTANCE_PX = 256;

/** Moves `current` toward `target` exponentially; frame-rate independent. Snaps after a teleport. */
export function approach(
  current: number,
  target: number,
  dtMs: number,
): number {
  if (Math.abs(target - current) > SNAP_DISTANCE_PX) return target;
  const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / SMOOTHING_MS);
  return current + (target - current) * alpha;
}
