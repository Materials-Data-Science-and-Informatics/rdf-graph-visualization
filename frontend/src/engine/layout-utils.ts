/** Pure helpers for the GPU engine (no three / WebGPU imports, unit-tested). */
import { UNTYPED_ALPHA } from "./curve";

export const DEFAULT_CAPACITY = 100_000;
const CAPACITY_ALIGN = 4096;
const CAPACITY_HEADROOM = 1.1;

/** GPU node capacity for a stream limit: 10% headroom (lazily created nodes), aligned to 4096. */
export function roundCapacity(maxNodes: number): number {
  const n = Math.max(1, Math.ceil(maxNodes * CAPACITY_HEADROOM));
  return Math.ceil(n / CAPACITY_ALIGN) * CAPACITY_ALIGN;
}

/** Smallest capacity >= `needed` reached by doubling `current`. */
export function growCapacity(current: number, needed: number): number {
  let c = Math.max(1, current);
  while (c < needed) c *= 2;
  return c;
}

/**
 * Undirected CSR adjacency (both directions, self loops skipped), written in place.
 * `offsets` needs length >= nodeCount + 1 (entries after nodeCount are filled with the
 * total, so nodes added later but not yet in the CSR simply have no neighbours);
 * `neigh` needs length >= 2 * edgeCount. Returns the number of neighbour entries.
 */
export function buildCsr(
  edges: Uint32Array,
  edgeCount: number,
  nodeCount: number,
  offsets: Uint32Array,
  neigh: Uint32Array
): number {
  offsets.fill(0);
  for (let e = 0; e < edgeCount; e++) {
    const s = edges[2 * e];
    const d = edges[2 * e + 1];
    if (s === d) continue;
    offsets[s + 1]++;
    offsets[d + 1]++;
  }
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] += offsets[i];
  const total = offsets[nodeCount];
  offsets.fill(total, nodeCount + 1);
  const fill = offsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const s = edges[2 * e];
    const d = edges[2 * e + 1];
    if (s === d) continue;
    neigh[fill[s]++] = d;
    neigh[fill[d]++] = s;
  }
  return total;
}

export interface Anchors {
  /** Per new node (index - nodeStart): placed node to spawn next to, -1 = none. */
  anchor: Int32Array;
  /** Chain length from the anchor through not-yet-placed nodes (0 = direct neighbour). */
  depth: Uint16Array;
}

/**
 * For each new node in [nodeStart, nodeEnd) pick the already-placed node it should
 * spawn next to: the lower-index endpoint of the first new edge that touches it. A
 * lower-index neighbour that is itself new is resolved through its own anchor, so the
 * result is always a node with index < nodeStart (placed in an earlier frame), which
 * lets the GPU init pass run without ordering hazards. Nodes with no new edge (or
 * whose chain ends in an unanchored node) get -1.
 */
export function computeAnchors(
  edges: Uint32Array,
  newEdgeStart: number,
  newEdgeEnd: number,
  nodeStart: number,
  nodeEnd: number
): Anchors {
  const len = Math.max(0, nodeEnd - nodeStart);
  const anchor = new Int32Array(len).fill(-1);
  const depth = new Uint16Array(len);
  for (let e = newEdgeStart; e < newEdgeEnd; e++) {
    const a = edges[2 * e];
    const b = edges[2 * e + 1];
    if (a === b) continue;
    const hi = Math.max(a, b);
    if (hi < nodeStart || hi >= nodeEnd) continue;
    if (anchor[hi - nodeStart] < 0) anchor[hi - nodeStart] = Math.min(a, b);
  }
  for (let i = 0; i < len; i++) {
    const a = anchor[i];
    if (a >= nodeStart) {
      anchor[i] = anchor[a - nodeStart]; // a < nodeStart + i, already resolved
      depth[i] = Math.min(0xffff, depth[a - nodeStart] + 1);
    }
  }
  return { anchor, depth };
}

/** Spawn jitter radius around the anchor, growing (capped) with the unplaced chain depth. */
export function jitterRadius(rest: number, depth: number): number {
  return rest * Math.min(3, 0.5 + 0.35 * depth);
}

export interface IndexRange {
  start: number;
  end: number; // exclusive
}

/**
 * Sort node indices and merge them into half-open ranges for partial buffer uploads;
 * indices closer than `maxGap` (exclusive of the gap itself) are merged too.
 */
export function coalesceRanges(indices: Iterable<number>, maxGap = 0): IndexRange[] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out: IndexRange[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i - last.end <= maxGap) last.end = i + 1;
    else out.push({ start: i, end: i + 1 });
  }
  return out;
}

export interface PositionFit {
  center: [number, number, number];
  /** Distance from the centroid below which `percentile` of the nodes lie. */
  radius: number;
}

/** Centroid and robust radius (percentile of node distances) of `count` vec-`stride` positions. */
export function fitFromPositions(
  pos: Float32Array,
  count: number,
  stride = 4,
  percentile = 0.95
): PositionFit {
  if (count <= 0) return { center: [0, 0, 0], radius: 0 };
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += pos[i * stride];
    cy += pos[i * stride + 1];
    cz += pos[i * stride + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;
  const d = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    d[i] = Math.hypot(pos[i * stride] - cx, pos[i * stride + 1] - cy, pos[i * stride + 2] - cz);
  }
  d.sort();
  const k = Math.min(count - 1, Math.max(0, Math.ceil(percentile * count) - 1));
  return { center: [cx, cy, cz], radius: d[k] };
}

/** Camera distance that frames a sphere of `radius` for a vertical fov (degrees), with margin. */
export function fitDistance(radius: number, fovDeg: number, margin = 1.1): number {
  return (radius / Math.sin((fovDeg * Math.PI) / 360)) * margin;
}

/** Alpha after one frame: geometric decay, snapped to 0 (frozen) below `stop`. */
export function nextAlpha(alpha: number, decay: number, stop: number): number {
  const a = alpha * decay;
  return a < stop ? 0 : a;
}

/**
 * Copy edges [from, to) of `src` (pairs) whose endpoints are both < `limit` to `dst`
 * starting at edge index `dstCount`; returns the new count. This is the "show first N
 * nodes" window: store indices are in BFS arrival order.
 */
export function appendWindowEdges(
  src: Uint32Array,
  from: number,
  to: number,
  limit: number,
  dst: Uint32Array,
  dstCount: number
): number {
  let n = dstCount;
  for (let e = from; e < to; e++) {
    const a = src[2 * e];
    const b = src[2 * e + 1];
    if (a < limit && b < limit) {
      dst[2 * n] = a;
      dst[2 * n + 1] = b;
      n++;
    }
  }
  return n;
}

export const NODE_LIMIT_MIN = 500;
export const NODE_LIMIT_MAX = 100_000;
export const NODE_LIMIT_DEFAULT = 5_000;

const roundSig = (n: number, sig = 3): number => {
  const p = 10 ** (Math.floor(Math.log10(n)) - sig + 1);
  return Math.round(n / p) * p;
};

/** Log-scale slider position t in [0,1] -> node limit in [NODE_LIMIT_MIN, NODE_LIMIT_MAX] (3 significant digits). */
export function sliderToCount(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  const lo = Math.log(NODE_LIMIT_MIN);
  const hi = Math.log(NODE_LIMIT_MAX);
  return Math.min(NODE_LIMIT_MAX, Math.max(NODE_LIMIT_MIN, roundSig(Math.exp(lo + c * (hi - lo)))));
}

export function countToSlider(n: number): number {
  const lo = Math.log(NODE_LIMIT_MIN);
  const hi = Math.log(NODE_LIMIT_MAX);
  return Math.min(1, Math.max(0, (Math.log(n) - lo) / (hi - lo)));
}

/**
 * Write per-node visibility (0 hidden, 1 typed, UNTYPED_ALPHA untyped) into the alpha slot of an rgba array.
 * Group indices outside [0, groupCount) count as -1 (unclassified).
 */
export function fillVisibility(
  rgba: Float32Array,
  groups: Int16Array,
  count: number,
  groupCount: number,
  hidden: ReadonlySet<number>
): void {
  for (let i = 0; i < count; i++) {
    const g = groups[i];
    const typed = g >= 0 && g < groupCount;
    rgba[i * 4 + 3] = hidden.has(typed ? g : -1) ? 0 : typed ? 1 : UNTYPED_ALPHA;
  }
}
