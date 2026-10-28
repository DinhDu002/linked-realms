// World layout (PLAN.md section 5.1). x grows east, y grows south.

export const LAND_SIZE_TILES = 64;

export interface Coordinates {
  x: number;
  y: number;
}

function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/** Coordinates of spiral index `n` (index 0 is the centre of the world). */
export function spiralCoordinates(n: number): Coordinates {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`invalid spiral index ${n}`);
  if (n === 0) return { x: 0, y: 0 };
  const k = Math.floor((isqrt(n) + 1) / 2);
  const t = n - (2 * k - 1) ** 2;
  if (t < 2 * k) return { x: k, y: -k + 1 + t };
  if (t < 4 * k) return { x: k - 1 - (t - 2 * k), y: k };
  if (t < 6 * k) return { x: -k, y: k - 1 - (t - 4 * k) };
  return { x: -k + 1 + (t - 6 * k), y: -k };
}

/** Land ids start at 1; Land `id` sits at spiral index `id - 1`. */
export function landCoordinates(landId: number): Coordinates {
  return spiralCoordinates(landId - 1);
}
