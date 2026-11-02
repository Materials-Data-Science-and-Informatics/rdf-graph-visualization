// GraphRenderer — the renderer-agnostic adapter contract (card D1).
//
// This module defines the interface every graph engine adapter (the headless
// stub for contract tests, and the sigma v3 / cosmos.gl / force-graph-3d
// adapters in D2/D3) must implement, plus the plain data types it operates on.
//
// The full, normative positions/state contract lives in CONTRACT.md next to
// this file. The TSDoc below mirrors it; when in doubt, CONTRACT.md wins.

/** A node as handed to a renderer. Positions are renderer-owned (CONTRACT.md §2). */
export interface RendererNode {
  id: string;
  label?: string;
  group?: string;
  color?: string;
  /**
   * Optional so callers can hand the store's `toGraphData()` output through
   * unchanged. The store never emits positions; the renderer assigns them.
   */
  x?: number;
  y?: number;
  z?: number;
}

/** A directed link as handed to a renderer. */
export interface RendererLink {
  id?: string;
  source: string;
  target: string;
  label?: string;
  color?: string;
}

/** The unit of data handoff: a full (re)placement of the visible graph. */
export interface RendererGraph {
  nodes: RendererNode[];
  links: RendererLink[];
}

/**
 * Current position of one node. 2D adapters omit `z`; 3D adapters must fill it.
 * Exposed via {@link GraphRenderer.getPositions} so a renderer switch (D4) can
 * carry positions over without re-layout.
 */
export interface NodePosition {
  x: number;
  y: number;
  z?: number;
}

/**
 * A graph engine adapter. Created through the registry (registry.ts), mounted
 * once into a container, then driven by the app until disposed.
 *
 * Lifecycle (CONTRACT.md §5): create → mount → set/focus/resize/resetView* →
 * dispose. Before mount, data methods throw (programming error). After
 * dispose, every method is a silent no-op and no callbacks are delivered.
 */
export interface GraphRenderer {
  /** Adapter id; matches the registry key it was created from. */
  readonly id: string;

  /**
   * Attach to a container element. Must be called exactly once, before any
   * data/view method. Throws if called a second time.
   */
  mount(container: HTMLElement): void;

  /**
   * Full data replacement with position memory (CONTRACT.md §2):
   * nodes that survived the previous call keep their positions, new nodes
   * get assigned positions, removed nodes have their state released.
   * After this call the renderer OWNS the handed objects and may mutate them
   * in place; the app must not keep references to them.
   */
  set(graph: RendererGraph): void;

  /**
   * Camera/fly-to request (CONTRACT.md §3). `sequence` is the store's
   * monotonic focusSequence (C2/E1). The renderer re-triggers only when
   * `sequence` is strictly greater than the last sequence it applied;
   * stale (non-increasing) tokens and unknown node ids are ignored.
   */
  focus(nodeId: string, sequence: number): void;

  /** Fit-all-nodes view (the "reset view" button). */
  resetView(): void;

  /** Update the render surface dimensions (container resize / fullscreen). */
  resize(width: number, height: number): void;

  /**
   * Subscribe to node activation. Returns an unsubscribe function.
   * One-way, renderer → app: the renderer reports the node id, the app
   * applies it to the store (select + focus + expand-on-click).
   * No callbacks are delivered after dispose().
   */
  onNodeSelect(callback: (nodeId: string) => void): () => void;

  /**
   * Snapshot of every position the renderer currently holds (CONTRACT.md
   * §2, P5). Lets D4's engine switch hand positions to the next adapter
   * instead of re-layouting.
   */
  getPositions(): ReadonlyMap<string, NodePosition>;

  /**
   * Tear down the engine and release resources. Must cancel in-flight work
   * (layout ticks, fly-to animations). All subsequent method calls are
   * silent no-ops; no further onNodeSelect callbacks are delivered.
   */
  dispose(): void;
}

/** Builds fresh renderer instances (the registry stores factories, not instances). */
export type RendererFactory = () => GraphRenderer;
