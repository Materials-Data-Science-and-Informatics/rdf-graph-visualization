/** All tunables of the force layout and look, in one place. */
export interface EngineConfig {
  /** Random repulsion samples per node and step (baked into the shader; scaled by n/K). */
  samples: number;
  /** Spring rest length in world units; everything else is expressed relative to it. */
  rest: number;
  spring: number;
  /** Repulsion strength as a multiple of rest^3. */
  repulsion: number;
  gravity: number;
  damping: number;
  /** Softening of the 1/r^2 repulsion as a multiple of rest^2. */
  epsilon: number;
  /** Max node speed per step as a multiple of rest. */
  speedClamp: number;
  /** Random per-step jiggle (multiple of rest) that keeps a settled graph "live". */
  jiggle: number;
  /** Force multiplier: reset to alphaStart when a graph (re)starts, bumped on growth, decays to alphaMin. */
  alphaStart: number;
  alphaMin: number;
  alphaDecay: number;
  alphaBump: number;
  /** Minimum interval between CSR/adjacency rebuilds while streaming. */
  csrIntervalMs: number;
  maxPixelRatio: number;
  /** Colour for nodes without a group. */
  noGroupColor: string;
}

export const DEFAULT_CONFIG: EngineConfig = {
  samples: 32,
  rest: 10,
  spring: 0.1,
  repulsion: 0.1,
  gravity: 0.02,
  damping: 0.85,
  epsilon: 0.05,
  speedClamp: 0.5,
  jiggle: 0.02,
  alphaStart: 1,
  alphaMin: 0.15,
  alphaDecay: 0.995,
  alphaBump: 0.6,
  csrIntervalMs: 200,
  maxPixelRatio: 2,
  noGroupColor: "#8a8f98",
};

/** Sphere diameter: large for small graphs, shrinking with node count (0.6 -> 0.2 of rest). */
export function nodeSize(rest: number, nodeCount: number): number {
  const f = 0.6 - 0.2 * Math.log10(Math.max(nodeCount, 100) / 100);
  return rest * Math.min(0.6, Math.max(0.2, f));
}

/** Edge opacity: fades as edge count grows so dense graphs do not wash out. */
export function edgeOpacity(edgeCount: number): number {
  return Math.max(0.04, 0.25 / (1 + edgeCount / 40_000));
}

/** Rough radius of the settled layout (used to frame the camera). */
export function estimateRadius(rest: number, nodeCount: number): number {
  return rest * (1 + Math.cbrt(Math.max(nodeCount, 1)) * 0.6);
}
