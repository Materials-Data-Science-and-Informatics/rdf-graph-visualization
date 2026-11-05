/**
 * Community regions for the 2D view: each detected community gets its own area of the map
 * (a sunflower arrangement, largest communities in the middle, area proportional to size),
 * so dense graphs read as separate clusters instead of one hairball.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface Regions {
  /** Centre per community [x0, y0, x1, y1, ...]. */
  centers: Float32Array;
  /** Radius per community. */
  radii: Float32Array;
}

/**
 * Region centres and radii for communities with the given sizes (index = community id,
 * ids are ordered largest first). `unit` is the space taken by one node (radius of a
 * one-node region); `gapFactor` > 1 leaves empty space between regions.
 */
export function communityRegions(
  sizes: ArrayLike<number>,
  center: number,
  unit: number,
  gapFactor = 1.6
): Regions {
  const k = sizes.length;
  const centers = new Float32Array(k * 2);
  const radii = new Float32Array(k);
  let area = 0; // cumulative area of the regions placed so far (in node units)
  for (let c = 0; c < k; c++) {
    radii[c] = unit * Math.sqrt(Math.max(1, sizes[c]));
    // sunflower: the c-th region sits just outside the area already used
    const r = c === 0 ? 0 : unit * gapFactor * Math.sqrt(area + sizes[c] / 2) * 1.2;
    const a = c * GOLDEN_ANGLE;
    centers[2 * c] = center + Math.cos(a) * r;
    centers[2 * c + 1] = center + Math.sin(a) * r;
    area += sizes[c] * gapFactor;
  }
  return { centers, radii };
}

/**
 * Region unit that keeps the whole sunflower inside `maxRadius` (the layout space is finite:
 * cosmos.gl clamps points at its border, which cut big graphs off with straight edges).
 * Returns `preferred` when that already fits.
 */
export function fittingUnit(
  sizes: ArrayLike<number>,
  preferred: number,
  maxRadius: number,
  gapFactor = 1.6
): number {
  let total = 0;
  for (let c = 0; c < sizes.length; c++) total += sizes[c];
  // outermost centre ~ unit * gap * sqrt(total * gap) * 1.2, plus that region's own radius
  const needed =
    gapFactor * Math.sqrt(total * gapFactor) * 1.2 +
    Math.sqrt(Math.max(1, sizes[sizes.length - 1] ?? 1));
  return needed > 0 ? Math.min(preferred, maxRadius / needed) : preferred;
}

/**
 * Move every community member into its region, keeping its offset from the community's
 * current centroid (internal structure) but scaled so the community fits its radius.
 * Nodes without a community (-1) are left where they are. Mutates `pos`.
 */
export function moveIntoRegions(pos: Float32Array, community: Int32Array, regions: Regions): void {
  const k = regions.radii.length;
  const sx = new Float64Array(k);
  const sy = new Float64Array(k);
  const cnt = new Uint32Array(k);
  const n = community.length;
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (c < 0 || c >= k) continue;
    sx[c] += pos[2 * i];
    sy[c] += pos[2 * i + 1];
    cnt[c]++;
  }
  const ext = new Float64Array(k); // max distance from the centroid
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (c < 0 || c >= k) continue;
    const d = Math.hypot(pos[2 * i] - sx[c] / cnt[c], pos[2 * i + 1] - sy[c] / cnt[c]);
    if (d > ext[c]) ext[c] = d;
  }
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (c < 0 || c >= k) continue;
    const s = ext[c] > 0 ? Math.min(1, regions.radii[c] / ext[c]) : 1;
    pos[2 * i] = regions.centers[2 * c] + (pos[2 * i] - sx[c] / cnt[c]) * s;
    pos[2 * i + 1] = regions.centers[2 * c + 1] + (pos[2 * i + 1] - sy[c] / cnt[c]) * s;
  }
}

/** Centroid per community [x0, y0, ...] of the current positions (for keeping a layout in place). */
export function communityCentroids(pos: Float32Array, community: Int32Array, k: number): number[] {
  const sum = new Float64Array(k * 2);
  const cnt = new Uint32Array(k);
  for (let i = 0; i < community.length; i++) {
    const c = community[i];
    if (c < 0 || c >= k) continue;
    sum[2 * c] += pos[2 * i];
    sum[2 * c + 1] += pos[2 * i + 1];
    cnt[c]++;
  }
  return Array.from(sum, (v, j) => v / Math.max(1, cnt[j >> 1]));
}
