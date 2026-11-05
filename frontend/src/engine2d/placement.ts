/** Pure position helpers for the 2D (cosmos.gl) view. */
import { computeAnchors } from "@/engine/layout-utils";

/** Spawn radius (space units) around an anchor, growing with the unplaced chain depth. */
const SPAWN_RADIUS = 12;
/** Spawn radius of a node without any placed neighbour, around the space centre. */
const LOOSE_RADIUS = 150;

/**
 * Position array [x0, y0, x1, y1, ...] for `total` nodes: the first `prevCount` entries are
 * copied from `prev` (the running layout), every later node spawns next to a placed neighbour
 * (see `computeAnchors`) or near `center` when it has none. `rnd` yields values in [0, 1).
 */
export function placeNodes(
  prev: Float32Array,
  prevCount: number,
  total: number,
  edges: Uint32Array,
  edgeCount: number,
  center: number,
  rnd: () => number = Math.random
): Float32Array {
  const out = new Float32Array(total * 2);
  const keep = Math.min(prevCount, total);
  out.set(prev.subarray(0, keep * 2));
  if (total <= keep) return out;
  const { anchor, depth } = computeAnchors(edges, 0, edgeCount, keep, total);
  for (let i = keep; i < total; i++) {
    const a = anchor[i - keep];
    const angle = rnd() * 2 * Math.PI;
    if (a >= 0 && a < keep) {
      const r = SPAWN_RADIUS * Math.min(3, 0.5 + 0.35 * depth[i - keep]) * (0.5 + rnd());
      out[2 * i] = out[2 * a] + Math.cos(angle) * r;
      out[2 * i + 1] = out[2 * a + 1] + Math.sin(angle) * r;
    } else {
      const r = LOOSE_RADIUS * Math.sqrt(rnd());
      out[2 * i] = center + Math.cos(angle) * r;
      out[2 * i + 1] = center + Math.sin(angle) * r;
    }
  }
  return out;
}
