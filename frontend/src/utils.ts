import CONFIG from "./config.ts";

/**
 * Palette helpers for the frozen API contract (see src/api/types.ts).
 *
 * The backend does all the vocabulary work: type→group resolution,
 * relation/label filtering, and skipping of irrelevant types. The frontend
 * only adds palette colours from the config (moved to /api/config in C4).
 *
 * Graph data mapping lives in the graph store (src/store/graph-store.ts,
 * toGraphData()); node/edge objects are copied there for the 3D engine.
 */

const getGroupColor = (group: string): string => {
  for (const g of CONFIG.groups) {
    if (g.name === group) {
      return g.color;
    }
  }
  return "gray";
};

export { getGroupColor };
