/** Pure mirrors of the edge-curve math that runs in the TSL shaders (kept in sync by hand; unit-tested). */
import type { Vec3 } from "./picking";

/** main's linkCurvature: control point offset = CURVATURE * edge length. */
export const EDGE_CURVATURE = 0.3;
/** Segments per curved edge strip (S+1 vertex pairs). Straight mode uses 1. */
export const EDGE_SEGMENTS = 8;
/** Node colour alpha of a visible node without a group (typed visible = 1, hidden = 0). */
export const UNTYPED_ALPHA = 0.75;
/** Alpha above this means the node has a group (typed). */
export const TYPED_THRESHOLD = 0.9;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * Unit perpendicular of the edge a->b: cross(dir, z), or cross(dir, y) when dir is nearly
 * parallel to z. Flips with the direction, so A->B and B->A bend to opposite sides.
 */
export function edgePerp(a: Vec3, b: Vec3): Vec3 {
  const d = sub(b, a);
  const len = Math.max(norm(d), 1e-4);
  const dn: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const up: Vec3 = Math.abs(dn[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const p = cross(dn, up);
  const pl = Math.max(norm(p), 1e-6);
  return [p[0] / pl, p[1] / pl, p[2] / pl];
}

/** Quadratic Bezier control point: midpoint + perp * curvature * length. */
export function controlPoint(a: Vec3, b: Vec3, curvature: number): Vec3 {
  const len = norm(sub(b, a));
  const p = edgePerp(a, b);
  return [0, 1, 2].map((k) => (a[k] + b[k]) / 2 + p[k] * curvature * len) as unknown as Vec3;
}

export function bezierPoint(a: Vec3, c: Vec3, b: Vec3, u: number): Vec3 {
  const v = 1 - u;
  return [0, 1, 2].map((k) => v * v * a[k] + 2 * v * u * c[k] + u * u * b[k]) as unknown as Vec3;
}

export function bezierTangent(a: Vec3, c: Vec3, b: Vec3, u: number): Vec3 {
  return [0, 1, 2].map(
    (k) => 2 * (1 - u) * (c[k] - a[k]) + 2 * u * (b[k] - c[k])
  ) as unknown as Vec3;
}

/**
 * Edge colour source: the source node's colour if it has a group, else the target's,
 * else none (-1: theme fallback). Mirrors main's `source.color ?? target.color ?? gray`.
 */
export function edgeColorSource(srcAlpha: number, dstAlpha: number): 0 | 1 | -1 {
  if (srcAlpha > TYPED_THRESHOLD) return 0;
  if (dstAlpha > TYPED_THRESHOLD) return 1;
  return -1;
}
