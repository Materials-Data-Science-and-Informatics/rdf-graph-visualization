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
//   - labels are adapter display state (S3, card D2): a deterministic
//     zoom/degree LOD runs in the nodeReducer, and a camera listener forces
//     one fresh data pass when a camera move crosses an LOD regime boundary
//     (sigma caches reducer output; pans and same-regime zooms cost nothing,
//     and the render itself always runs in sigma's own frame loop);
//   - selection is one-way: sigma's "clickNode" event → onNodeSelect(id)
//     (S1) — the id only, never the (renderer-owned) node object;
//   - lifecycle L1–L4: data methods throw before mount, every method is a
//     silent no-op after dispose(), dispose() is idempotent and kills sigma
//     (which cancels its in-flight animation frames, unbinds all listeners,
//     and frees the GL contexts).

import Graph from "graphology";
import Sigma from "sigma";

import { getGroupColor } from "../config";
import type { LayoutWorkerClient, LayoutRequest } from "./layout-worker";
import { createLayoutWorker } from "./layout-worker";
import { adoptedCoordinate } from "./renderer";
import type { GraphRenderer, NodePosition, RendererGraph } from "./renderer";
import { seedPosition2D } from "./seeding";
import type { ForceAtlas2Settings } from "./forceatlas2";

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

/** Options for a force-atlas2 layout run started on this adapter. */
export interface SigmaLayoutOptions {
  /** Total iterations (default 300). */
  iterations?: number;
  /** Iterations per posted tick (default 16). */
  iterationsPerTick?: number;
  settings?: Partial<ForceAtlas2Settings>;
}

/** Default label LOD: every label is shown while the camera ratio ≤ this. */
export const LABEL_ZOOM_RATIO = 2.5;
/** Default label LOD: high-degree labels are shown while the camera ratio ≤ this. */
export const LABEL_HIGH_DEGREE_ZOOM_RATIO = 5;
/** Default label LOD: node degree that counts as "high-degree" (tie-break). */
export const LABEL_HIGH_DEGREE_MIN = 10;

/**
 * Label level-of-detail thresholds (card D2 S3). Labels are renderer
 * display state (CONTRACT.md §2): the nodeReducer keeps or drops the label
 * from the camera zoom ratio and the node degree — a label shows while the
 * ratio ≤ zoomRatio, high-degree nodes keep theirs out to
 * highDegreeZoomRatio. All thresholds are deterministic constants; nothing
 * here ever touches positions.
 */
export interface SigmaLabelLodOptions {
  /** Master switch; false keeps every label (sigma's own heuristics only). */
  enabled?: boolean;
  /** Show every label while the camera ratio ≤ this (default {@link LABEL_ZOOM_RATIO}). */
  zoomRatio?: number;
  /** Show high-degree labels while the camera ratio ≤ this (default {@link LABEL_HIGH_DEGREE_ZOOM_RATIO}, floored at zoomRatio). */
  highDegreeZoomRatio?: number;
  /** Degree that counts as high-degree (default {@link LABEL_HIGH_DEGREE_MIN}). */
  highDegreeMin?: number;
}

/** The sigma camera's current view state (2D; the adapter never rotates). */
export interface SigmaCameraState {
  x: number;
  y: number;
  ratio: number;
}

/**
 * The label LOD decision currently baked into a node's cached sigma display
 * data — what the reducer decided for the node at the last data pass.
 */
export interface SigmaNodeLabelState {
  /** The label the renderer shows for the node right now (null = hidden). */
  label: string | null;
  /** True when the label survives sigma's own density/size heuristics. */
  forceLabel: boolean;
}

/**
 * The sigma 2D adapter. Everything on the base GraphRenderer plus explicit
 * layout control: the force-atlas2 run happens in the adapter's OWN Web
 * Worker (CONTRACT.md L3 — the renderer owns its layout ticks and cancels
 * them on dispose()), and the worker's position snapshots are applied to the
 * adapter's own graph attributes (P1 — positions stay renderer-owned; there
 * is no external apply-positions API in the base contract on purpose).
 */
export interface SigmaRenderer extends GraphRenderer, SigmaRendererDiagnostics {
  /**
   * Start (or restart) a force-atlas2 layout over the current graph, from
   * the current positions. Ticks land as attribute updates while it runs;
   * `layoutRunning` flips to false on the final tick or after stopLayout().
   */
  startLayout(options?: SigmaLayoutOptions): void;
  /** Ask the layout worker to stop; the last applied tick stands. */
  stopLayout(): void;
  /** True while a layout run is in flight. */
  readonly layoutRunning: boolean;
  /**
   * Current sigma camera view state, or null before mount / after dispose.
   * `ratio` is sigma's zoom ratio (bigger = more zoomed out).
   */
  getCameraState(): SigmaCameraState | null;
  /**
   * Apply a camera view state immediately (no animation). Label LOD reacts
   * to it (card D2 S3). Silent no-op after dispose, throws before mount.
   */
  setCameraState(view: Partial<SigmaCameraState>): void;
  /**
   * The label LOD decision currently in the node's cached sigma display data
   * (see {@link SigmaNodeLabelState}), or null for an unknown node / before
   * mount / after dispose. Diagnostic seam: the app's data surface stays the
   * contract methods.
   */
  getNodeLabelState(nodeId: string): SigmaNodeLabelState | null;
}

export interface SigmaRendererOptions {
  /**
   * Layout-worker factory. Defaults to createLayoutWorker (browser Worker).
   * Headless tests inject a node:worker_threads-backed implementation of
   * the same interface — the adapter itself stays runtime-agnostic.
   */
  layoutWorkerFactory?: () => LayoutWorkerClient;
  /** Label LOD thresholds (card D2 S3); defaults see {@link SigmaLabelLodOptions}. */
  labelLod?: SigmaLabelLodOptions;
}

/** The registry id the app registers this factory under (engines.ts). */
export const SIGMA_RENDERER_ID = "sigma";

/**
 * Factory for the sigma 2D adapter. The registry (registry.ts) stores this,
 * never instances — every call returns a fresh, unmounted renderer.
 */
export function createSigmaRenderer(
  id: string = SIGMA_RENDERER_ID,
  factoryOptions: SigmaRendererOptions = {}
): SigmaRenderer {
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

  // Layout worker state (adapter-owned, L3): one worker per renderer,
  // created lazily on the first startLayout, terminated on dispose().
  let layoutClient: LayoutWorkerClient | null = null;
  let layoutUnsubscribe: (() => void) | null = null;
  let layoutRunning = false;
  /** id → position index for the CURRENT run (the worker's snapshot layout). */
  let layoutIndex: Map<string, number> | null = null;

  function teardownLayout(): void {
    layoutRunning = false;
    layoutIndex = null;
    if (layoutUnsubscribe) {
      layoutUnsubscribe();
      layoutUnsubscribe = null;
    }
    if (layoutClient) {
      layoutClient.dispose();
      layoutClient = null;
    }
  }

  function applyLayoutTick(positions: Float32Array): void {
    if (!layoutIndex) return;
    // Only apply to nodes that are still in the graph (a set() mid-run
    // cancels the run, but be defensive: never write a stale snapshot into
    // a node the run did not originate).
    for (const [nodeId, i] of layoutIndex) {
      if (graph.hasNode(nodeId)) {
        graph.mergeNodeAttributes(nodeId, { x: positions[2 * i], y: positions[2 * i + 1] });
      }
    }
  }

  function stopLayout(): void {
    if (disposed) return;
    if (layoutClient) layoutClient.stopLayout();
    layoutRunning = false;
  }

  // True when the operation may proceed. Post-dispose it returns false
  // (silent no-op, contract §5 L3); before mount it throws (L2). Callers
  // branch on the flag — a void guard here would silently re-run bodies
  // after teardown (same bug class the stub's comment warns about).
  function guard(op: string): boolean {
    if (disposed) return false;
    if (!mounted) throw new Error(`renderer "${id}": ${op} before mount`);
    return true;
  }

  // ---- label LOD (S3) -------------------------------------------------
  // Resolution order: a label shows iff the camera ratio is within its
  // threshold, and a node's threshold is the high-degree one only when its
  // degree clears the tie-break. sigma's own density/size heuristics run on
  // top; high-degree keepers set forceLabel so hub labels survive them.
  const labelLod: Required<SigmaLabelLodOptions> = {
    enabled: factoryOptions.labelLod?.enabled ?? true,
    zoomRatio: factoryOptions.labelLod?.zoomRatio ?? LABEL_ZOOM_RATIO,
    highDegreeZoomRatio: Math.max(
      factoryOptions.labelLod?.highDegreeZoomRatio ?? LABEL_HIGH_DEGREE_ZOOM_RATIO,
      factoryOptions.labelLod?.zoomRatio ?? LABEL_ZOOM_RATIO
    ),
    highDegreeMin: factoryOptions.labelLod?.highDegreeMin ?? LABEL_HIGH_DEGREE_MIN,
  };
  // The camera ratio the last data pass evaluated (null until sigma has run
  // one). Used to detect a zoom crossing an LOD boundary so we know when a
  // re-render is actually required — sigma caches the reducer output, so a
  // pure camera move within one regime needs no relabel and a move ACROSS a
  // regime must force one data pass. Three regimes: all labels, high-degree
  // only, none.
  let lodAppliedRatio: number | null = null;

  /** The LOD regime a camera ratio falls into (0 all / 1 high-degree / 2 none). */
  function lodRegime(ratio: number): 0 | 1 | 2 {
    if (!labelLod.enabled || ratio <= labelLod.zoomRatio) return 0;
    if (ratio <= labelLod.highDegreeZoomRatio) return 1;
    return 2;
  }

  /** Whether a node of this degree keeps its label at this camera ratio. */
  function lodKeepsLabel(degree: number, ratio: number): boolean {
    if (!labelLod.enabled) return true;
    if (ratio <= labelLod.zoomRatio) return true;
    return degree >= labelLod.highDegreeMin && ratio <= labelLod.highDegreeZoomRatio;
  }

  const renderer: SigmaRenderer = {
    id,

    get lastFocus(): { nodeId: string; sequence: number } | null {
      return lastFocus;
    },

    get layoutRunning(): boolean {
      return layoutRunning;
    },

    startLayout(options: SigmaLayoutOptions = {}): void {
      if (!guard("startLayout")) return;
      if (graph.order === 0) return; // nothing to lay out
      const nodes: string[] = [];
      const positions = new Float64Array(2 * graph.order);
      let i = 0;
      for (const nodeId of graph.nodes()) {
        const attrs = graph.getNodeAttributes(nodeId);
        if (!Number.isFinite(attrs.x) || !Number.isFinite(attrs.y)) {
          throw new Error(
            `renderer "${id}": startLayout needs finite x/y on every node ("${nodeId}")`
          );
        }
        positions[2 * i] = attrs.x;
        positions[2 * i + 1] = attrs.y;
        nodes.push(nodeId);
        i++;
      }
      const indexOf = new Map(nodes.map((nodeId, idx) => [nodeId, idx]));
      const links: [number, number][] = [];
      for (const edge of graph.edges()) {
        const s = indexOf.get(graph.source(edge));
        const t = indexOf.get(graph.target(edge));
        if (s !== undefined && t !== undefined) links.push([s, t]);
      }

      if (!layoutClient) {
        layoutClient = (factoryOptions.layoutWorkerFactory ?? createLayoutWorker)();
        layoutUnsubscribe = layoutClient.onTick((tick) => {
          // Guarded twice: a tick that arrives after dispose() (the worker
          // is terminated, but be exact) or after stopLayout()/set() must
          // not touch the graph (L3).
          if (disposed || !layoutRunning || !layoutClient) return;
          applyLayoutTick(tick.positions);
          if (tick.done) layoutRunning = false;
        });
      }
      layoutIndex = indexOf;
      layoutRunning = true;
      const request: LayoutRequest = {
        nodes,
        links,
        positions,
        iterations: options.iterations,
        iterationsPerTick: options.iterationsPerTick,
        settings: options.settings,
      };
      layoutClient.startLayout(request);
    },

    stopLayout,

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
        // Label LOD (S3): keep the label only where the current camera
        // ratio allows it for the node's degree; high-degree keepers also
        // set forceLabel so hub labels survive sigma's own density/size
        // heuristics. Display-only — positions are never touched here.
        nodeReducer: (node, data) => {
          const ratio = sigma ? sigma.getCamera().getState().ratio : 1;
          lodAppliedRatio = ratio;
          const degree = graph.degree(node);
          const keep = lodKeepsLabel(degree, ratio);
          return {
            ...data,
            label: keep ? (data.label ?? null) : null,
            forceLabel: keep && labelLod.enabled && degree >= labelLod.highDegreeMin,
            color: getGroupColor(typeof data.group === "string" ? data.group : ""),
          };
        },
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
      // Label LOD reacts to zoom with NO app-side invalidation (S3): sigma
      // caches reducer output across camera moves, so a camera event that
      // crosses an LOD regime boundary forces ONE fresh data pass (the
      // reducer then re-reads the live ratio). Pans and same-regime zooms
      // cost nothing; the render itself runs in sigma's own frame loop.
      s.getCamera().on("updated", () => {
        if (disposed || !sigma || lodAppliedRatio === null) return;
        const ratio = sigma.getCamera().getState().ratio;
        if (lodRegime(ratio) === lodRegime(lodAppliedRatio)) return;
        sigma.refresh({ schedule: true });
      });
    },

    set(g: RendererGraph): void {
      if (!guard("set") || !sigma) return;
      // A layout run is a one-shot convergence over the data snapshot that
      // existed when it started; new data invalidates it — the app calls
      // startLayout() again if it wants the new graph laid out.
      if (layoutRunning) stopLayout();
      const wanted = new Set(g.nodes.map((n) => n.id));

      // P4: release state for nodes that vanished (graphology drops their
      // incident edges as well).
      for (const gone of graph.nodes()) {
        if (!wanted.has(gone)) graph.dropNode(gone);
      }

      // P2/P3/P7: survivors keep their exact x/y (the attributes are left
      // alone); new nodes take the handed finite coordinates when present
      // (the D4 engine-switch handoff, CONTRACT.md §2 P7), else a
      // deterministic seed.
      for (const node of g.nodes) {
        if (graph.hasNode(node.id)) {
          graph.mergeNodeAttributes(node.id, {
            label: node.label ?? null,
            group: node.group ?? null,
          });
        } else {
          const seed = seedPosition2D(node.id);
          graph.addNode(node.id, {
            x: adoptedCoordinate(node.x) ?? seed.x,
            y: adoptedCoordinate(node.y) ?? seed.y,
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

    getCameraState(): SigmaCameraState | null {
      if (!sigma || disposed) return null;
      const { x, y, ratio } = sigma.getCamera().getState();
      return { x, y, ratio };
    },

    setCameraState(view: Partial<SigmaCameraState>): void {
      if (!guard("setCameraState") || !sigma) return;
      sigma.getCamera().setState(view);
    },

    getNodeLabelState(nodeId: string): SigmaNodeLabelState | null {
      if (!sigma || disposed || !graph.hasNode(nodeId)) return null;
      const data = sigma.getNodeDisplayData(nodeId);
      if (!data) return null;
      return { label: data.label ?? null, forceLabel: data.forceLabel === true };
    },

    dispose(): void {
      if (disposed) return; // L4: idempotent
      disposed = true;
      listeners.clear();
      lastFocus = null;
      lodAppliedRatio = null;
      teardownLayout(); // L3: cancel the layout run, terminate its worker
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
