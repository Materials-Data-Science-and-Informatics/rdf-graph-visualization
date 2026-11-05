/** All tunables of the force layout and look, in one place. */
export interface EngineConfig {
  /** Random repulsion samples per node and step (baked into the shader; scaled by n/K). */
  samples: number;
  /** Extra repulsion samples taken from the node's own 2-hop ring (weight 1 each; keeps local neighbourhoods apart). */
  ringSamples: number;
  /** Spring rest length in world units (d3 forceLink distance; node radius is rest/6, main's 5 vs 30). */
  rest: number;
  /** Multiplier on the d3 link strength 1/min(deg(src), deg(dst)). */
  spring: number;
  /** d3 many-body strength (|F| = strength/d, falloff 1/d); the n/K sampling scale is applied on top. */
  repulsion: number;
  /**
   * NOT d3's forceCenter. A very weak pull toward the origin that only stops disconnected
   * components from drifting apart without bound; effectively 0 for connected graphs.
   */
  gravity: number;
  /** d3 velocityDecay: velocity *= (1 - velocityDecay) per tick. */
  velocityDecay: number;
  /** Minimum squared distance in the repulsion (d3 distanceMin^2 = 1). */
  epsilon: number;
  /** Safety clamp on node speed per step as a multiple of rest (d3 has none; sampling noise needs one). */
  speedClamp: number;
  /** Force multiplier (d3 alpha): alphaStart when a graph (re)starts, re-heated on growth, decays to alphaStop. */
  alphaStart: number;
  /** Below this alpha the layout is frozen: no compute dispatch at all. */
  alphaStop: number;
  /** Per-tick multiplier; d3 alphaDecay 0.0228 -> 0.9772. */
  alphaDecay: number;
  /** Re-heat level when the node limit changes. */
  alphaLimitChange: number;
  /** Re-heat level when the graph grows (modest: settled nodes should barely move). */
  alphaBump: number;
  /** Force multiplier of nodes that already existed when a re-heat started (new nodes: 1). */
  oldMobility: number;
  /** Camera auto-fit: readback interval while simulating, distance percentile, elevation. */
  fitIntervalMs: number;
  fitPercentile: number;
  viewElevationDeg: number;
  /** Minimum interval between CSR/adjacency rebuilds while streaming. */
  csrIntervalMs: number;
  maxPixelRatio: number;
  /** Colour for nodes without a group. */
  noGroupColor: string;
}

export const DEFAULT_CONFIG: EngineConfig = {
  samples: 32,
  ringSamples: 8,
  rest: 30,
  spring: 1,
  repulsion: 30,
  gravity: 0.001,
  velocityDecay: 0.3,
  epsilon: 1,
  speedClamp: 1,
  alphaStart: 1,
  alphaStop: 0.001,
  alphaDecay: 0.9772,
  alphaBump: 0.3,
  alphaLimitChange: 0.5,
  oldMobility: 0.06,
  fitIntervalMs: 500,
  fitPercentile: 0.95,
  viewElevationDeg: 22,
  csrIntervalMs: 200,
  maxPixelRatio: 2,
  noGroupColor: "#8a8f98",
};

/** Node radius = rest/6: main's r=5 spheres on 30-unit links. */
export function nodeRadius(rest: number): number {
  return rest / 6;
}

/**
 * Edge opacity: clearly visible, fading gently as edge count grows. Dark theme 0.5 -> 0.15,
 * light theme 0.6 -> 0.2 (normal blending in both).
 */
export function edgeOpacity(edgeCount: number, dark: boolean): number {
  const f = 1 / (1 + edgeCount / 60_000);
  return dark ? Math.max(0.15, 0.5 * f) : Math.max(0.2, 0.6 * f);
}

/** Rough radius of the settled layout (used to frame the camera). */
export function estimateRadius(rest: number, nodeCount: number): number {
  return rest * (1 + Math.cbrt(Math.max(nodeCount, 1)) * 0.6) + nodeRadius(rest);
}
