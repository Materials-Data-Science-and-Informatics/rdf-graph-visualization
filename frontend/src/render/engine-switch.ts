// Card D4 — the renderer-switch core (CONTRACT.md §2 P5/P7).
//
// The engine toggle swaps the mounted renderer WITHOUT touching the store:
// no refetch (the data is the same filtered snapshot the app already has),
// no relayout (positions are carried over via getPositions() → set()), no
// lost selection (selection is store-owned, §4 S1 — the store is never
// touched by a switch, and the focus token is replayed by the host).
//
// This module is the engine-agnostic half of that operation: pure functions
// over the contract types, no React, no DOM — so the exact handoff the hook
// performs can be unit-tested in Node against the stub and the real adapters.

import { adoptedCoordinate } from "./renderer";
import type { NodePosition, RendererGraph, RendererLink, RendererNode } from "./renderer";

/**
 * Deep-copy a graph into fresh objects the incoming renderer can own
 * (CONTRACT.md §1.2: after set() the renderer owns the handed objects and
 * may mutate them; the app must keep no references — so a switch, which
 * re-sets the SAME logical graph into a new renderer, needs its own copies).
 */
export function snapshotGraph(graph: RendererGraph): RendererGraph {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    links: graph.links.map((link) => ({ ...link })),
  };
}

/**
 * Prepare a graph for the INCOMING renderer of an engine switch: deep-copy
 * it and fill each node with the position the OUTGOING renderer held for
 * its id (CONTRACT.md §2 P5 → P7). Nodes without a carried position are
 * copied as-is — the incoming adapter seeds them deterministically (P3).
 *
 * The input is never mutated: the outgoing renderer still owns those objects
 * until it is disposed, and the host keeps the snapshot as its own record of
 * the last data it set.
 */
export function withCarriedPositions(
  graph: RendererGraph,
  positions: ReadonlyMap<string, NodePosition>
): RendererGraph {
  const nodes = graph.nodes.map((node): RendererNode => {
    const next: RendererNode = { ...node };
    const pos = positions.get(node.id);
    if (pos !== undefined) {
      next.x = adoptedCoordinate(pos.x);
      next.y = adoptedCoordinate(pos.y);
      next.z = adoptedCoordinate(pos.z);
    }
    return next;
  });
  const links = graph.links.map((link: RendererLink): RendererLink => ({ ...link }));
  return { nodes, links };
}
