import { GraphData, LinkObject, NodeObject } from "react-force-graph-3d";
import type { SubgraphResponse } from "./api/types";
import CONFIG from "./config.ts";

/**
 * Graph-data mapping for the frozen API contract (see src/api/types.ts).
 *
 * The backend does all the vocabulary work: type→group resolution,
 * relation/label filtering, and skipping of irrelevant types. The frontend
 * only adds palette colours from the config and returns force-graph data.
 */

const getGroupColor = (group: string): string => {
  for (const g of CONFIG.groups) {
    if (g.name === group) {
      return g.color;
    }
  }
  return "gray";
};

/**
 * Convert one typed /api/subgraph slice into force-directed graph data.
 * Edges referencing nodes outside the slice are dropped (the backend only
 * emits edges between slice members, this is defensive).
 */
const subgraphToGraphData = (slice: SubgraphResponse): GraphData => {
  const nodes: NodeObject<NodeType>[] = slice.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    group: n.group,
    color: getGroupColor(n.group),
  }));

  const colorById = new Map(nodes.map((n) => [n.id, n.color ?? "gray"]));

  const links: LinkObject<NodeType, LinkType>[] = slice.edges
    .filter((e) => colorById.has(e.source) && colorById.has(e.target))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      // source colour, else target colour, else default gray (legacy look)
      color: colorById.get(e.source) ?? colorById.get(e.target) ?? "gray",
    }));

  return { nodes, links } as GraphData;
};

export { subgraphToGraphData, getGroupColor };
