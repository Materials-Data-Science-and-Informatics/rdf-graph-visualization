// Card D3 — deterministic 2,000-node fixture for the cosmos.gl render check
// (scripts/cosmos-render-check.ts). A connected graph: a ring plus a set of
// deterministic cross-links, spread over a handful of groups so S2's per-group
// colours have variety. No randomness — the render check must be reproducible.

import type { RendererGraph } from "../../src/render/renderer";

const GROUPS = ["ClassA", "ClassB", "ClassC", "ClassD", "ClassE"] as const;

export function makeTwoThousandNodeGraph(nodeCount = 2000): RendererGraph {
  const nodes: RendererGraph["nodes"] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node-${i}`,
      label: `Node ${i}`,
      group: GROUPS[i % GROUPS.length] ?? "ClassA",
    });
  }

  const seen = new Set<string>();
  const links: RendererGraph["links"] = [];
  const addLink = (source: number, target: number): void => {
    if (source === target) return;
    const key = `${Math.min(source, target)}|${Math.max(source, target)}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ id: `e-${key}`, source: `node-${source}`, target: `node-${target}` });
  };

  for (let i = 0; i < nodeCount; i++) {
    addLink(i, (i + 1) % nodeCount); // ring keeps the graph connected
    addLink(i, (i * 7 + 3) % nodeCount); // deterministic cross-links
  }

  return { nodes, links };
}
