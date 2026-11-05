/** Pure position helpers for the 2D (cosmos.gl) view. */
import { computeAnchors } from "@/engine/layout-utils";

/** Spawn radius (space units) around an anchor, growing with the unplaced chain depth. */
const SPAWN_RADIUS = 15;
/** Phyllotaxis: spawn radius grows by this * sqrt(children already spawned), so a hub starts as a full disc. */
const PHYLLO_RADIUS = 3;
/** Golden angle: successive children of one anchor fill the full circle evenly. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
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
  // per anchor: how many children were spawned around it so far (random start angle each)
  const spawned = new Map<number, { n: number; start: number }>();
  for (let i = keep; i < total; i++) {
    const a = anchor[i - keep];
    let angle = rnd() * 2 * Math.PI;
    if (a >= 0 && a < keep) {
      let s = spawned.get(a);
      if (!s) spawned.set(a, (s = { n: 0, start: angle }));
      const n = s.n++;
      angle = s.start + n * GOLDEN_ANGLE; // all around the anchor, not a random clump
      const r =
        (SPAWN_RADIUS * Math.min(3, 0.75 + 0.35 * depth[i - keep]) + PHYLLO_RADIUS * Math.sqrt(n)) *
        (0.8 + 0.4 * rnd());
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

/** Share of a new generation's nodes that must keep their position for the layout to carry over. */
export const CARRY_KEEP = 0.5;

/**
 * Positions for a new graph of `total` nodes (`ids`) seeded from the previous layout by IRI:
 * nodes whose id is in `prevIds[0, prevCount)` keep their `prev` position, others spawn next to a
 * placed neighbour (repeated over the edges, so whole chains follow) or near `center`.
 * `carried` is the number of nodes that kept a position.
 */
export function placeCarried(
  prev: Float32Array,
  prevIds: readonly string[],
  prevCount: number,
  ids: readonly string[],
  edges: Uint32Array,
  edgeCount: number,
  center: number,
  rnd: () => number = Math.random
): { pos: Float32Array; carried: number } {
  const old = new Map<string, number>();
  for (let i = 0; i < prevCount; i++) old.set(prevIds[i], i);
  const total = ids.length;
  const pos = new Float32Array(total * 2);
  const placed = new Uint8Array(total);
  let carried = 0;
  for (let i = 0; i < total; i++) {
    const j = old.get(ids[i]);
    if (j === undefined) continue;
    pos[2 * i] = prev[2 * j];
    pos[2 * i + 1] = prev[2 * j + 1];
    placed[i] = 1;
    carried++;
  }
  const spawn = (i: number, from: number) => {
    const angle = rnd() * 2 * Math.PI;
    const r = SPAWN_RADIUS * (0.8 + 0.4 * rnd());
    pos[2 * i] = pos[2 * from] + Math.cos(angle) * r;
    pos[2 * i + 1] = pos[2 * from + 1] + Math.sin(angle) * r;
    placed[i] = 1;
  };
  for (let pass = 0, changed = true; changed && pass < 8; pass++) {
    changed = false;
    for (let e = 0; e < edgeCount; e++) {
      const a = edges[2 * e];
      const b = edges[2 * e + 1];
      if (a >= total || b >= total || placed[a] === placed[b]) continue;
      if (placed[a]) spawn(b, a);
      else spawn(a, b);
      changed = true;
    }
  }
  for (let i = 0; i < total; i++) {
    if (placed[i]) continue;
    const angle = rnd() * 2 * Math.PI;
    const r = LOOSE_RADIUS * Math.sqrt(rnd());
    pos[2 * i] = center + Math.cos(angle) * r;
    pos[2 * i + 1] = center + Math.sin(angle) * r;
  }
  return { pos, carried };
}
