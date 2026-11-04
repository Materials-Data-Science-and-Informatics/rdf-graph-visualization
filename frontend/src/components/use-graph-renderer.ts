// Card D4 — the hook that drives the mounted GraphRenderer from app state.
//
// The DoD this hook exists for: an engine switch must be
//   - no refetch  — the store is never touched; the incoming renderer re-sets
//                   the SAME filtered snapshot the app already has;
//   - no relayout — the outgoing renderer's getPositions() snapshot is
//                   carried into the incoming one (CONTRACT.md §2 P5 → P7);
//                   a switch never starts a layout run;
//   - no lost selection — selection/focus are store-owned (CONTRACT.md §4),
//                   so they survive untouched, and the focus token is replayed
//                   on the incoming renderer (its sequence gate is cold, so
//                   the replay flies the camera back to the selection).
//
// Layout policy (sigma's force-atlas2 worker, adapter-owned): a run starts
// only when (a) a cold renderer (no carried positions) receives its first
// data, or (b) the data gains NEW node ids (initial load / cursor-page
// expand). Filter-only changes and engine switches never start one.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  createRenderer,
  defaultRendererId,
  listRenderers,
  snapshotGraph,
  withCarriedPositions,
} from "../render";
import type { CosmosRenderer } from "../render";
import type { GraphRenderer, NodePosition, RendererGraph, SigmaRenderer } from "../render";
import { graphStore, useGraphStoreVersion } from "../store/use-graph-store";
import { initialViewState, updateSearchKeys } from "../view-state";

export interface UseGraphRendererOptions {
  /** The current filtered graph (fresh copies; the renderer owns what it gets). */
  graph: RendererGraph;
  /** Node activation, renderer → app (select + focus + expand-on-click). */
  onNodeSelect?: (nodeId: string) => void;
  /** Container width in px (0 before the first measurement). */
  width: number;
  /** Container height in px (0 before the first measurement). */
  height: number;
  /** App theme; adapters that draw their own background follow it (card D3 S2). */
  theme: "light" | "dark";
}

export interface UseGraphRendererResult {
  /** Attach to the element the current renderer mounts into. */
  containerRef: RefObject<HTMLDivElement>;
  /** Active engine id (a registered one). */
  engineId: string;
  /** Switch the engine (no-op for the active / an unknown id). */
  setEngineId: (id: string) => void;
  /** Registered engine ids, in registration order (drives the toggle UI). */
  engines: string[];
  /** V3: fit all current nodes into view (the reset-view button). */
  resetView: () => void;
  /** Current engine's camera (adapter-specific; null when unavailable). */
  getCameraState: () => unknown;
}

/** True when `nodeId` is among the graph's nodes (focus-replay guard). */
function graphHasNode(graph: RendererGraph | null, nodeId: string): boolean {
  return graph?.nodes.some((node) => node.id === nodeId) ?? false;
}

/** Whether the adapter supports layout runs (sigma does; cosmos does not). */
function supportsLayout(renderer: GraphRenderer): renderer is GraphRenderer & SigmaRenderer {
  return typeof (renderer as Partial<SigmaRenderer>).startLayout === "function";
}

/** Push the app theme into adapters that draw their own background. */
function applyTheme(renderer: GraphRenderer, theme: "light" | "dark"): void {
  if (typeof (renderer as Partial<CosmosRenderer>).setTheme === "function") {
    (renderer as CosmosRenderer).setTheme(theme);
  }
}

export function useGraphRenderer(options: UseGraphRendererOptions): UseGraphRendererResult {
  const { graph, width, height, theme } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);
  /** Last snapshot handed to the CURRENT renderer (kept for the next switch). */
  const lastGraphRef = useRef<RendererGraph | null>(null);
  /** Node ids the current renderer already holds positions for (layout gate). */
  const knownNodeIdsRef = useRef<Set<string>>(new Set());
  /**
   * Position snapshot captured from a renderer its effect is about to
   * dispose — consumed by the next engine effect run as the carried P5
   * handoff (React runs the cleanup before the new effect, and a disposed
   * renderer reports an empty map, L3).
   */
  const pendingPositionsRef = useRef<Map<string, NodePosition> | null>(null);
  /** Latest onNodeSelect, read from the effect without re-subscribing. */
  const onNodeSelectRef = useRef(options.onNodeSelect);
  onNodeSelectRef.current = options.onNodeSelect;
  /** Latest container size, read by the engine effect without re-creating. */
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  /** Latest theme, read by the engine effect (a fresh cosmos engine must
   * start with the CURRENT theme, not the one from the opened URL). */
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Card C3: initial engine from the opened URL, validated against the
  // registry (an unknown id degrades to the default, same as a bad theme).
  const [engineId, setEngineState] = useState<string>(() => {
    const ids = listRenderers();
    const wanted = initialViewState.engine;
    if (wanted && ids.includes(wanted)) return wanted;
    return defaultRendererId() ?? ids[0] ?? "";
  });

  // Card C3: keep the URL's `engine` key in step (the default is omitted).
  useEffect(() => {
    updateSearchKeys({ engine: engineId === defaultRendererId() ? null : engineId });
  }, [engineId]);

  // ---------------------------------------------------------------- engine
  // Mount the renderer for `engineId`; when the id changes, run the D4
  // switch: carry positions over (P5/P7), replay the focus token. The store
  // is never touched.
  //
  // Lifecycle note: React runs the PREVIOUS effect's cleanup before the next
  // run, so the outgoing renderer is already disposed when a switch's effect
  // starts — and a disposed renderer hands an empty map by contract (L3).
  // The cleanup therefore captures the outgoing renderer's getPositions()
  // snapshot into pendingPositionsRef BEFORE disposing, and the next effect
  // run consumes it. An empty pending snapshot (initial mount, StrictMode
  // remount of a renderer that never received data) means "cold".
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !listRenderers().includes(engineId)) return;

    const carried = pendingPositionsRef.current;
    pendingPositionsRef.current = null;
    const hasCarried = (carried?.size ?? 0) > 0;

    const incoming = createRenderer(engineId);
    rendererRef.current = incoming;
    incoming.mount(container);
    incoming.onNodeSelect((nodeId) => onNodeSelectRef.current?.(nodeId));

    let fresh: RendererGraph | null = null;
    const last = lastGraphRef.current;
    if (last) {
      fresh = hasCarried && carried ? withCarriedPositions(last, carried) : snapshotGraph(last);
      lastGraphRef.current = fresh;
      incoming.set(fresh);
    }
    // The incoming renderer now "knows" exactly the ids it was handed — the
    // data effect's new-ids check must see a switch as growth-free (no
    // relayout on switch, card D4 DoD).
    knownNodeIdsRef.current = new Set(fresh ? fresh.nodes.map((node) => node.id) : []);

    // Focus replay (V2): the incoming renderer's sequence gate is cold
    // (lastApplied = -1), so the store's current focus token re-triggers the
    // fly-to — the selection keeps the camera after a switch.
    const focusId = graphStore.focusId;
    if (focusId && graphStore.focusSequence > 0 && graphHasNode(fresh, focusId)) {
      incoming.focus(focusId, graphStore.focusSequence);
    }

    // Cold start with data already in hand (a remount where the data effect
    // ran first, or StrictMode's second pass): lay it out. A switch
    // (hasCarried) never starts a layout.
    if (fresh && fresh.nodes.length > 0 && !hasCarried && supportsLayout(incoming)) {
      incoming.startLayout();
    }

    const { width: w, height: h } = sizeRef.current;
    if (w > 0 && h > 0) incoming.resize(w, h);
    applyTheme(incoming, themeRef.current);

    return () => {
      // Capture the outgoing renderer's position snapshot BEFORE dispose
      // (L3: a disposed renderer returns an empty map) — the next effect
      // run (an engine switch) hands it to the incoming renderer (P5).
      pendingPositionsRef.current = new Map(incoming.getPositions());
      incoming.dispose();
      if (rendererRef.current === incoming) rendererRef.current = null;
      // lastGraphRef is kept on purpose: the next effect run (StrictMode
      // remount) or a later switch derives its own fresh copies from it.
    };
  }, [engineId]);

  // ------------------------------------------------------------------ data
  // Feed the filtered graph to the mounted renderer; start a layout run only
  // when the data gains NEW node ids (initial load / cursor-page expand).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const fresh = snapshotGraph(graph);
    lastGraphRef.current = fresh;
    renderer.set(fresh);

    const ids = new Set(fresh.nodes.map((node) => node.id));
    let grew = false;
    for (const id of ids) {
      if (!knownNodeIdsRef.current.has(id)) {
        grew = true;
        break;
      }
    }
    knownNodeIdsRef.current = ids;
    if (grew && supportsLayout(renderer)) {
      renderer.startLayout();
    }
  }, [graph]);

  // ------------------------------------------------------------------ focus
  // Apply the store's focus token on every store bump; the renderer's V2
  // gate ignores duplicates, so unrelated bumps are a no-op.
  useGraphStoreVersion();
  useEffect(() => {
    const renderer = rendererRef.current;
    const id = graphStore.focusId;
    if (!renderer || id === null || graphStore.focusSequence === 0) return;
    renderer.focus(id, graphStore.focusSequence);
  });

  // ----------------------------------------------------------------- resize
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || width <= 0 || height <= 0) return;
    renderer.resize(width, height);
  }, [width, height]);

  // ------------------------------------------------------------------ theme
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) applyTheme(renderer, theme);
  }, [theme]);

  const resetView = useCallback(() => {
    rendererRef.current?.resetView();
  }, []);

  const getCameraState = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || typeof (renderer as Partial<SigmaRenderer>).getCameraState !== "function") {
      return null;
    }
    return (renderer as SigmaRenderer).getCameraState();
  }, []);

  const setEngineId = useCallback((id: string) => {
    setEngineState((current) => {
      if (id === current) return current;
      return listRenderers().includes(id) ? id : current;
    });
  }, []);

  return {
    containerRef,
    engineId,
    setEngineId,
    engines: listRenderers(),
    resetView,
    getCameraState,
  };
}
