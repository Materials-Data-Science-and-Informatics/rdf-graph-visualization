/**
 * Leaf discs for the 2D view: degree-1 nodes ("leaves") are not left to the force layout
 * (repulsion from the dense core piles them into a fan on one side of their hub); instead
 * they are pinned on a phyllotaxis disc centred on their hub, so the hub stays in the middle
 * with its leaves all around it.
 */

/** Golden angle: successive leaves fill the disc evenly in every direction. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface LeafGroups {
  /** Hub node index per group. */
  hubs: Uint32Array;
  /** Leaves of group g: leaves[offsets[g] .. offsets[g + 1]). */
  offsets: Uint32Array;
  leaves: Uint32Array;
}

/**
 * Group the leaves (degree 1, neighbour degree >= 2) of the window by their hub. Edges are
 * index pairs; only edges with both ends < n count. Hubs with fewer than `minLeaves`
 * leaves are skipped (small stars lay out fine with the forces alone).
 */
export function findLeafGroups(
  n: number,
  edges: Uint32Array,
  edgeCount: number,
  degrees: Uint32Array,
  minLeaves = 3
): LeafGroups {
  const hubOf = new Int32Array(n).fill(-1);
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    if (a >= n || b >= n || a === b) continue;
    if (degrees[a] === 1 && degrees[b] >= 2) hubOf[a] = b;
    else if (degrees[b] === 1 && degrees[a] >= 2) hubOf[b] = a;
  }
  const count = new Uint32Array(n);
  for (let i = 0; i < n; i++) if (hubOf[i] >= 0) count[hubOf[i]]++;
  const hubs: number[] = [];
  for (let h = 0; h < n; h++) if (count[h] >= minLeaves) hubs.push(h);
  const slot = new Int32Array(n).fill(-1);
  hubs.forEach((h, g) => (slot[h] = g));
  const offsets = new Uint32Array(hubs.length + 1);
  for (let g = 0; g < hubs.length; g++) offsets[g + 1] = offsets[g] + count[hubs[g]];
  const leaves = new Uint32Array(offsets[hubs.length]);
  const fill = offsets.slice(0, hubs.length);
  for (let i = 0; i < n; i++) {
    const g = hubOf[i] >= 0 ? slot[hubOf[i]] : -1;
    if (g >= 0) leaves[fill[g]++] = i;
  }
  return { hubs: Uint32Array.from(hubs), offsets, leaves };
}

/** All leaf indices of the groups (the points to pin). */
export function leafIndices(groups: LeafGroups): number[] {
  return Array.from(groups.leaves);
}

/**
 * Write each group's leaf positions into `pos` ([x0, y0, ...]) as a phyllotaxis disc around
 * the hub's current position: leaf k at radius gap + spacing * sqrt(k + 0.5), angle
 * k * golden angle (+ a per-hub phase). `sizes` are point sizes (space units).
 */
export function placeLeafDiscs(pos: Float32Array, groups: LeafGroups, sizes: Float32Array): void {
  const { hubs, offsets, leaves } = groups;
  for (let g = 0; g < hubs.length; g++) {
    const h = hubs[g];
    const hx = pos[2 * h];
    const hy = pos[2 * h + 1];
    const from = offsets[g];
    const to = offsets[g + 1];
    let leafSize = 0;
    for (let k = from; k < to; k++) leafSize = Math.max(leafSize, sizes[leaves[k]]);
    const spacing = leafSize * 0.95;
    const gap = sizes[h] / 2 + leafSize;
    const phase = (h * 0.618034 * 2 * Math.PI) % (2 * Math.PI);
    for (let k = from; k < to; k++) {
      const j = k - from;
      const r = gap + spacing * Math.sqrt(j + 0.5);
      const a = phase + j * GOLDEN_ANGLE;
      const i = leaves[k];
      pos[2 * i] = hx + Math.cos(a) * r;
      pos[2 * i + 1] = hy + Math.sin(a) * r;
    }
  }
}
