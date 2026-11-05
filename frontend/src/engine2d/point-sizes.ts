/** Per-point sizes for the 2D view: size grows with the number of connections, capped; the root stays largest. */

export const BASE_SIZE = 3;
export const SIZE_PER_SQRT_DEGREE = 1.2;
export const MAX_SIZE = 18;
/** The root is at least this much bigger than the cap. */
export const ROOT_SIZE = MAX_SIZE + 4;

/** Degree of each of the first `n` points over the window's edges (`edges` = [a0, b0, ...]). */
export function computeDegrees(n: number, edges: Uint32Array, edgeCount: number): Uint32Array {
  const deg = new Uint32Array(n);
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    if (a < n && b < n) {
      deg[a]++;
      deg[b]++;
    }
  }
  return deg;
}

/** Sizes for the first `n` points from their degree; node 0 is the root. */
export function computePointSizes(n: number, deg: Uint32Array): Float32Array {
  const sizes = new Float32Array(n);
  for (let i = 0; i < n; i++)
    sizes[i] = Math.min(MAX_SIZE, BASE_SIZE + SIZE_PER_SQRT_DEGREE * Math.sqrt(deg[i]));
  if (n > 0) sizes[0] = Math.max(sizes[0], ROOT_SIZE);
  return sizes;
}
