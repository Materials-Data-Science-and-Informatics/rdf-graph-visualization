/** Pure helpers for GPU picking, click classification and position carry-over (no three imports). */

export type PickKind = "node" | "edge";

/** What is under the pointer. `index` is the store index (node) or the GPU edge-list index (edge). */
export interface PickHit {
  kind: PickKind;
  index: number;
  /** Edge only: endpoint node indices, read from the GPU edge list at pick time. */
  src?: number;
  dst?: number;
  /** Edge only: index of the edge in the GraphStore (predicate lookup). */
  storeEdge?: number;
}

const EDGE_FLAG = 0x80000000;

/** Encode a pick id as one uint32 (RGBA8, little-endian): 0 = nothing, edges set bit 31. */
export function encodePickId(kind: PickKind, index: number): number {
  const id = index + 1;
  return (kind === "edge" ? id | EDGE_FLAG : id) >>> 0;
}

export function decodePickId(v: number): { kind: PickKind; index: number } | null {
  const u = v >>> 0;
  if (u === 0) return null;
  const edge = (u & EDGE_FLAG) !== 0;
  const id = (u & ~EDGE_FLAG) >>> 0;
  if (id === 0) return null;
  return { kind: edge ? "edge" : "node", index: id - 1 };
}

/** The uint32 stored in pixel `p` of an RGBA8 buffer. */
export function pixelId(px: ArrayLike<number>, p: number): number {
  const o = p * 4;
  return (px[o] | (px[o + 1] << 8) | (px[o + 2] << 16) | (px[o + 3] << 24)) >>> 0;
}

/**
 * Choose the hit in an `n` x `n` RGBA8 window centred on the pointer: the nearest node pixel
 * wins; only if no node is in the window, the nearest edge pixel.
 */
export function choosePick(
  px: ArrayLike<number>,
  n: number
): { kind: PickKind; index: number } | null {
  const c = (n - 1) / 2;
  let node: { d: number; index: number } | null = null;
  let edge: { d: number; index: number } | null = null;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const hit = decodePickId(pixelId(px, y * n + x));
      if (!hit) continue;
      const d = (x - c) ** 2 + (y - c) ** 2;
      if (hit.kind === "node") {
        if (!node || d < node.d) node = { d, index: hit.index };
      } else if (!edge || d < edge.d) edge = { d, index: hit.index };
    }
  }
  if (node) return { kind: "node", index: node.index };
  if (edge) return { kind: "edge", index: edge.index };
  return null;
}

export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export const CLICK_MAX_MOVE_PX = 5;
/** Touch taps must also be quick; a mouse click has no time limit. */
export const TOUCH_TAP_MAX_MS = 500;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 20;

/** A click is a pointer up within ~5 px of the down (and within `maxMs`, touch only); else a drag/hold. */
export function classifyPointer(
  down: PointerSample,
  up: PointerSample,
  maxMove = CLICK_MAX_MOVE_PX,
  maxMs = Infinity
): "click" | "drag" {
  const moved = Math.hypot(up.x - down.x, up.y - down.y);
  return moved <= maxMove && up.t - down.t <= maxMs ? "click" : "drag";
}

export type Vec3 = readonly [number, number, number];

/** id -> xyz of the first `ids.length` vec4 positions. */
export function buildCarryMap(ids: readonly string[], pos: Float32Array): Map<string, Vec3> {
  const m = new Map<string, Vec3>();
  for (let i = 0; i < ids.length; i++) m.set(ids[i], [pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]]);
  return m;
}

/**
 * Nodes [from, to) whose id is in `carry` get that position (written into `pos`, vec4 stride)
 * and `init[i*4+2] = 1` (the spawn kernel then keeps the position and zeroes the velocity);
 * all others get flag 0. Returns the carried indices.
 */
export function applyCarry(
  ids: readonly string[],
  from: number,
  to: number,
  carry: ReadonlyMap<string, Vec3>,
  pos: Float32Array,
  init: Float32Array
): number[] {
  const carried: number[] = [];
  for (let i = from; i < to; i++) {
    const p = carry.get(ids[i]);
    if (p) {
      pos[i * 4] = p[0];
      pos[i * 4 + 1] = p[1];
      pos[i * 4 + 2] = p[2];
      pos[i * 4 + 3] = 1;
      init[i * 4 + 2] = 1;
      carried.push(i);
    } else {
      init[i * 4 + 2] = 0;
    }
  }
  return carried;
}
