/** Per-point sizes for the 2D view: communities' hubs and the root stand out, degree adds a subtle hint. */
import type { Communities } from "./communities";

export const BASE_SIZE = 4;
export const ROOT_SIZE = 24;
const HUB_PER_SQRT = 1.2;
const HUB_CAP = 20;
const DEGREE_PER_SQRT = 0.25;
const DEGREE_CAP = 1.5;

/** Size of a community hub: grows with sqrt(community size), capped so it never covers its members. */
export function hubSize(communitySize: number): number {
  return Math.min(HUB_CAP, BASE_SIZE + HUB_PER_SQRT * Math.sqrt(communitySize));
}

/** Sizes for the first `n` points; `edges` = [a0, b0, ...] over the store's edge list, node 0 is the root. */
export function computePointSizes(
  n: number,
  edges: Uint32Array,
  edgeCount: number,
  communities: Communities | null
): Float32Array {
  const deg = new Uint32Array(n);
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    if (a < n && b < n) {
      deg[a]++;
      deg[b]++;
    }
  }
  const sizes = new Float32Array(n);
  for (let i = 0; i < n; i++)
    sizes[i] = BASE_SIZE + Math.min(DEGREE_CAP, DEGREE_PER_SQRT * Math.sqrt(deg[i]));
  if (communities) {
    communities.hubs.forEach((h, c) => {
      if (h < n) sizes[h] = hubSize(communities.sizes[c]);
    });
  }
  if (n > 0) sizes[0] = Math.max(sizes[0], ROOT_SIZE);
  return sizes;
}
