// Card D2 — sigma 2D adapter.
//
// Implements the GraphRenderer contract (renderer.ts, normative spec in
// CONTRACT.md) on top of sigma.js — npm package `sigma` 3.0.0 (the project's
// v3 line; see engines.ts for why the package is pinned).
//
// Design:
//   - the adapter OWNS a graphology Graph; positions live in node attributes
//     (x/y), which is exactly what sigma's scene reads (P1);
//   - set() is a replacement with position memory: surviving ids keep their
//     x/y attributes untouched (P2), new ids are seeded deterministically
//     from the id (P3, seeding.ts), removed ids are dropped with all state
//     (P4);
//   - getPositions() snapshots the graph attributes — 2D, no z (P6);
//   - focus() applies the strictly-increasing-sequence gate (V2) and pans
//     the camera to the node; resetView() fits the current bounding box (V3);
//   - selection is one-way: sigma's "clickNode" event → onNodeSelect(id)
//     (S1) — the id only, never the (renderer-owned) node object;
//   - lifecycle L1–L4: data methods throw before mount, every method is a
//     silent no-op after dispose(), dispose() is idempotent and kills sigma
//     (which cancels its in-flight animation frames, unbinds all listeners,
//     and frees the GL contexts).

import Graph from "graphology";
import Sigma from "sigma";

import { getGroupColor } from "../config";
import type { GraphRenderer, NodePosition, RendererGraph } from "./renderer";
import { seedPosition2D } from "./seeding";

/** Node attributes the adapter stores (positions are renderer-owned, P1). */
interface NodeAttrs {
  x: number;
  y: number;
  label: string | null;
  group: string | null;
}

/** Edge attributes the adapter stores. */
interface EdgeAttrs {
  label: string | null;
  color: string | null;
}

/**
 * Last focus request actually APPLIED (CONTRACT.md §3 V2 — stale, duplicate,
 * and unknown-id requests do not count). Diagnostic mirror of the internal
 * sequence gate; the contract test reads it exactly like the stub's.
 */
export interface SigmaRendererDiagnostics {
  lastFocus: { nodeId: string; sequence: number } | null;
}

export type SigmaRenderer = GraphRenderer & SigmaRendererDiagnostics;

/** The registry id the app registers this factory under (engines.ts). */
export const SIGMA_RENDERER_ID = "sigma";

/**
 * Factory for the sigma 2D adapter. The registry (registry.ts) stores this,
 * never instances — every call returns a fresh, unmounted renderer.
 */
export function createSigmaRenderer(id: string = SIGMA_RENDERER_ID): SigmaRenderer {
  let mounted = false;
  let disposed = false;
  let sigma: Sigma<NodeAttrs, EdgeAttrs> | null = null;
  let containerRef: HTMLElement | null = null;
  let lastFocus: { nodeId: string; sequence: number } | null = null;
  let lastAppliedSequence = -1;
  const listeners = new Set<(nodeId: string) => void>();
  // Directed, like the store's graph: a (source, target) pair is one edge,
  // and the handed links carry direction (predicate order matters in RDF).
  const graph = new Graph<NodeAttrs, EdgeAttrs>({ type: "directed" });

  // True when the operation may proceed. Post-dispose it returns false
  // (silent no-op, contract §5 L3); before mount it throws (L2). Callers
  // branch on the flag — a void guard here would silently re-run bodies
  // after teardown (same bug class the stub's comment warns about).
  function guard(op: string): boolean {
    if (disposed) return false;
    if (!mounted) throw new Error(`renderer "${id}": ${op} before mount`);
    return true;
  }

  const renderer: SigmaRenderer = {
    id,

    get lastFocus(): { nodeId: string; sequence: number } | null {
      return lastFocus;
    },

    mount(container: HTMLElement): void {
      if (disposed) return;
      if (mounted) throw new Error(`renderer "${id}": already mounted`);
      mounted = true;
      containerRef = container;
      const s = new Sigma(graph, container, {
        // NOTE: sigma uses the reducer's return value as the node's FULL
        // display data (it does not merge), so the raw attributes — x/y in
        // particular — must be passed through with `...data`.
        // Node colour tracks the LIVE /api/config palette (card C4) instead
        // of a set()-time snapshot: the reducer runs on every refresh.
        nodeReducer: (_node, data) => ({
          ...data,
          label: data.label ?? null,
          color: getGroupColor(typeof data.group === "string" ? data.group : ""),
        }),
        edgeReducer: (_edge, data) => ({
          ...data,
          label: data.label ?? null,
          color: data.color ?? "#ccc",
        }),
      });
      sigma = s;
      // S1: one-way activation, id only.
      s.on("clickNode", (payload) => {
        if (disposed) return;
        for (const listener of listeners) listener(payload.node);
      });
    },

    set(g: RendererGraph): void {
      if (!guard("set") || !sigma) return;
      const wanted = new Set(g.nodes.map((n) => n.id));

      // P4: release state for nodes that vanished (graphology drops their
      // incident edges as well).
      for (const gone of graph.nodes()) {
        if (!wanted.has(gone)) graph.dropNode(gone);
      }

      // P2/P3: survivors keep their exact x/y (the attributes are left
      // alone); new nodes get deterministic, finite seed positions.
      for (const node of g.nodes) {
        if (graph.hasNode(node.id)) {
          graph.mergeNodeAttributes(node.id, {
            label: node.label ?? null,
            group: node.group ?? null,
          });
        } else {
          const seed = seedPosition2D(node.id);
          graph.addNode(node.id, {
            x: seed.x,
            y: seed.y,
            label: node.label ?? null,
            group: node.group ?? null,
          });
        }
      }

      // graphology 0.26 keys edges internally (addEdge takes no explicit
      // key), so edge identity is the (source, target) pair — the same key
      // the store dedupes on (C2).
      const wantedPairs = new Map<string, { source: string; target: string }>();
      for (const link of g.links) {
        wantedPairs.set(`${link.source}\u0000${link.target}`, {
          source: link.source,
          target: link.target,
        });
      }
      for (const key of graph.edges()) {
        const pair = `${graph.source(key)}\u0000${graph.target(key)}`;
        if (!wantedPairs.has(pair)) graph.dropEdge(key);
      }
      for (const link of g.links) {
        if (!graph.hasEdge(link.source, link.target)) {
          graph.addEdge(link.source, link.target, {
            label: link.label ?? null,
            color: link.color ?? null,
          });
        }
      }

      // The graph mutations above schedule a refresh through sigma's own
      // graph handlers; this explicit refresh() guarantees one is queued
      // even when the diff produced no graphology events (e.g. attribute-
      // only changes on surviving nodes). The render itself runs on the
      // next animation frame — headless tests pump it via fake-dom's
      // flushRaf().
      sigma.refresh();
    },

    focus(nodeId: string, sequence: number): void {
      if (!guard("focus") || !sigma) return;
      if (!graph.hasNode(nodeId)) return; // unknown id: no-op, token NOT consumed (V2)
      if (sequence <= lastAppliedSequence) return; // stale/duplicate token: ignored (V2)
      lastAppliedSequence = sequence;
      lastFocus = { nodeId, sequence };
      const attrs = graph.getNodeAttributes(nodeId);
      // Pan the camera so the node is centred; the zoom level is preserved.
      sigma.getCamera().setState({ x: attrs.x, y: attrs.y });
    },

    resetView(): void {
      if (!guard("resetView") || !sigma) return;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      graph.forEachNode((_, pos) => {
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y);
      });
      const camera = sigma.getCamera();
      if (!Number.isFinite(minX)) {
        // Empty graph: a sane home position.
        camera.setState({ x: 0, y: 0, ratio: 100 });
        return;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      // camera.ratio is the radius of the visible area in graph units; fit
      // the bounding box with sigma's stage padding.
      const radius = Math.max(maxX - minX, maxY - minY) / 2 + sigma.getSetting("stagePadding");
      camera.setState({ x: cx, y: cy, ratio: Math.max(radius, 1e-6) });
    },

    resize(width: number, height: number): void {
      if (!guard("resize") || !sigma || !containerRef) return;
      containerRef.style.width = `${width}px`;
      containerRef.style.height = `${height}px`;
      sigma.resize(true);
    },

    onNodeSelect(callback: (nodeId: string) => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    getPositions(): ReadonlyMap<string, NodePosition> {
      const positions = new Map<string, NodePosition>();
      if (!mounted || disposed) return positions;
      graph.forEachNode((node, pos) => {
        // P6: 2D adapter — no z.
        positions.set(node, { x: pos.x, y: pos.y });
      });
      return positions;
    },

    dispose(): void {
      if (disposed) return; // L4: idempotent
      disposed = true;
      listeners.clear();
      lastFocus = null;
      if (sigma) {
        sigma.kill(); // cancels frames, unbinds captors/window, frees GL
        sigma = null;
      }
      graph.clear();
      containerRef = null;
      mounted = false;
    },
  };

  return renderer;
}
