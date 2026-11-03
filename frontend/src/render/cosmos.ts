// Card D3 — cosmos.gl (`@cosmos.gl/graph`) adapter behind the GraphRenderer
// contract (src/render/CONTRACT.md).
//
// cosmos.gl is a GPU-accelerated, **2D** force graph (positions are `[x, y]`;
// there is no z-axis — see CONTRACT.md §2 P6: 2D adapters omit `z`). The
// luma.gl engine it renders through is a peer dependency, pinned explicitly
// in package.json (see card D3, S2).
//
// Design — an authoritative position map, a dumb engine:
//
//   The adapter OWNS a per-id position map (contract §2 P1). It seeds new
//   nodes deterministically (P3), keeps surviving nodes' positions exact
//   across `set()` (P2), and releases removed ids (P4). `getPositions()`
//   returns that map (P5). The cosmos engine is driven with the
//   simulation and rescaling DISABLED (`enableSimulation: false`,
//   `rescalePositions: false`) so it renders exactly the positions we hand
//   it — it never fights the contract's position memory. The engine is pure
//   renderer + view + picking: `setPointPositions`/`setLinks`/`render`,
//   `zoomToPointByIndex` (focus), `fitView` (reset view), and `onPointClick`
//   (node activation).
//
//   A force-layout "settle" is deliberately NOT used: the contract mandates
//   deterministic position memory (a full reload must reproduce the layout,
//   and ingesting a cursor page must not scatter existing nodes), which a
//   live GPU simulation would defeat.
//
// Dual-mode for headless verification:
//
//   `mount(container)` constructs the real WebGL `Graph` only when given a
//   genuine DOM element. When the container is null / non-DOM (the Node
//   contract test) — or WebGL is unavailable — the adapter runs in a
//   **state-only** ("headless") mode: every contract method still works
//   against the position map, but no GL canvas is created. This mirrors
//   cosmos.gl's own headless mode and is what lets the full positions/state
//   contract run in Node. The module's top-level import of `@cosmos.gl/graph`
//   is DOM/WebGL-free, so importing it under Node is safe; only `new Graph()`
//   needs a GPU context, and we never call that in headless mode.
//
// Inspection surface:
//
//   `CosmosRenderer` extends `GraphRenderer` with the same read-only test /
//   host-activation hooks the D1 stub exposes (`lastFocus`, `lastSize`,
//   `setCount`, `mounted`, `disposed`, `emitNodeSelect`) so the contract
//   suite (CONTRACT.md §7) can verify a real adapter headlessly. They are
//   inert in normal browser use; `emitNodeSelect` is also the host-driven
//   activation path (e.g. an external picking layer reporting a click).

import { Graph } from "@cosmos.gl/graph";
import type { GraphConfig } from "@cosmos.gl/graph";
import type { GraphRenderer, NodePosition, RendererGraph } from "./renderer";

/** A 2D point position (x, y) — the adapter's authoritative per-node layout. */
type Point2D = [number, number];

/**
 * Extension of the contract with the read-only inspection / host-activation
 * surface described above. A production GraphRenderer consumer sees only
 * `GraphRenderer`; these members exist so the contract suite (and any host
 * picking layer) can drive and observe the adapter headlessly.
 */
export interface CosmosRenderer extends GraphRenderer {
  /**
   * Deliver a node activation (fires `onNodeSelect` listeners). The browser
   * path fires this from cosmos' own `onPointClick`; a headless / host-driven
   * path calls it directly. No-op after dispose().
   */
  emitNodeSelect(nodeId: string): void;
  /** Last focus request actually APPLIED (stale / unknown requests don't count). */
  readonly lastFocus: { nodeId: string; sequence: number } | null;
  /** Last `resize()` dimensions, or null. */
  readonly lastSize: { width: number; height: number } | null;
  /** Number of `set()` calls that were actually applied. */
  readonly setCount: number;
  readonly mounted: boolean;
  readonly disposed: boolean;
  /** True when no GL engine was constructed (state-only mode). */
  readonly headless: boolean;
}

// Seed space, in cosmos "space" units (see config.spaceSize below). New nodes
// land here; with `rescalePositions: false` these coordinates are rendered
// verbatim, so a reload reproduces the layout (CONTRACT.md §2 P3).
const SPACE_SIZE = 4096;
const SPAN = 4000;

/** djb2 — small, fast, good enough to seed a per-id PRNG (matches the D1 stub). */
function djb2(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return hash >>> 0;
}

/** mulberry32 — deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 2D seed for a node id: same id → same point (P3). */
function seedPosition(nodeId: string): Point2D {
  const random = mulberry32(djb2(nodeId));
  return [random() * SPAN, random() * SPAN];
}

/** True when `container` is a genuine DOM element (not null / a test stub). */
function isDomElement(container: unknown): container is HTMLElement {
  return typeof container === "object" && container !== null && "nodeType" in container;
}

export function createCosmosRenderer(id = "cosmos"): CosmosRenderer {
  let mounted = false;
  let disposed = false;
  let headless = true;
  let lastFocus: { nodeId: string; sequence: number } | null = null;
  let lastAppliedSequence = -1;
  let lastSize: { width: number; height: number } | null = null;
  let setCount = 0;

  // Authoritative position memory (contract §2 P1). Survivors keep their
  // entry across set(); new ids are seeded; removed ids are deleted.
  const positions = new Map<string, Point2D>();
  // Current data, in node order (drives index→id mapping for links + clicks).
  let nodeIds: string[] = [];
  let links: RendererGraph["links"] = [];
  const listeners = new Set<(nodeId: string) => void>();

  // The live engine (null in headless mode / before a real mount).
  let engine: Graph | null = null;

  // Returns true when the operation may proceed. Post-dispose → false (silent
  // no-op, contract §5); before mount → throws (L2). NOTE: a *void* guard is a
  // bug — the caller must branch on the flag (same trap the D1 stub documents).
  function guard(op: string): boolean {
    if (disposed) return false;
    if (!mounted) throw new Error(`renderer "${id}": ${op} before mount`);
    return true;
  }

  /** Fire node-activation listeners (one-way, renderer → app, contract §4). */
  function dispatch(nodeId: string): void {
    if (disposed) return;
    for (const listener of listeners) listener(nodeId);
  }

  /** Upload the current data to the engine (no-op in headless mode). */
  function applyToEngine(): void {
    if (!engine) return;
    const n = nodeIds.length;
    const pointPositions = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = positions.get(nodeIds[i]);
      if (p) {
        pointPositions[i * 2] = p[0];
        pointPositions[i * 2 + 1] = p[1];
      }
    }
    const index = new Map(nodeIds.map((nodeId, i) => [nodeId, i] as const));
    const linkPairs = links.filter((link) => index.has(link.source) && index.has(link.target));
    const linkArray = new Float32Array(linkPairs.length * 2);
    linkPairs.forEach((link, i) => {
      linkArray[i * 2] = index.get(link.source) as number;
      linkArray[i * 2 + 1] = index.get(link.target) as number;
    });
    // `dontRescale: true` — render our positions verbatim (P2/P3).
    engine.setPointPositions(pointPositions, true);
    engine.setLinks(linkArray);
    // Snap, no transition: a data replacement is not an animation.
    engine.render(undefined, 0);
  }

  function engineConfig(onPointClick: (index: number) => void): GraphConfig {
    return {
      // S1: minimal render config — positions + links only. Node/edge STYLING
      // (per-group colours, point sizes/shapes, link widths/opacity, theming)
      // is card D3 S2 and lives in the config the styling step introduces.
      backgroundColor: "#000000",
      spaceSize: SPACE_SIZE,
      rescalePositions: false,
      enableSimulation: false,
      pointDefaultSize: 8,
      pointDefaultColor: "#b3b3b3",
      linkDefaultWidth: 1,
      linkDefaultColor: "#7a7a7a",
      linkDefaultArrows: false,
      enableDrag: true,
      // Empty string hides cosmos.gl's default "Powered by cosmos.gl" label.
      attribution: "",
      onPointClick,
    };
  }

  const renderer: CosmosRenderer = {
    get id() {
      return id;
    },
    get mounted() {
      return mounted;
    },
    get disposed() {
      return disposed;
    },
    get headless() {
      return headless;
    },
    get lastFocus() {
      return lastFocus;
    },
    get lastSize() {
      return lastSize;
    },
    get setCount() {
      return setCount;
    },

    mount(container: HTMLElement): void {
      if (disposed) return;
      if (mounted) throw new Error(`renderer "${id}": already mounted`);
      mounted = true;

      if (isDomElement(container)) {
        try {
          // A real element: build the WebGL engine. Device init is async
          // internally; method calls made before it is ready are queued by
          // cosmos.gl (see the constructor docs), so set() can run immediately.
          // The contract's mount() takes an HTMLElement, but cosmos.gl's
          // container is an HTMLDivElement — the app always mounts into a div.
          engine = new Graph(
            container as HTMLDivElement,
            engineConfig((index) => {
              const nodeId = nodeIds[index];
              if (nodeId !== undefined) dispatch(nodeId);
            })
          );
          headless = false;
          // Safety net: once the device is ready, push whatever we hold so the
          // first frame is populated even if set() was called pre-ready.
          engine.ready.then(() => {
            if (mounted && !disposed) applyToEngine();
          });
        } catch (err) {
          // No usable WebGL context → degrade to state-only mode rather than
          // crash. Positions/selection still work; there is just no canvas.
          console.warn(`renderer "${id}": WebGL init failed, running headless`, err);
          engine = null;
          headless = true;
        }
      }
      // Null / non-DOM container: stay headless (state-only). No engine.
    },

    set(graph: RendererGraph): void {
      if (!guard("set")) return;
      setCount += 1;

      // P4: release state for ids that vanished from the graph.
      const present = new Set(graph.nodes.map((node) => node.id));
      for (const gone of [...positions.keys()]) {
        if (!present.has(gone)) positions.delete(gone);
      }
      // P2/P3: survivors keep their exact position; new ids get a seeded one.
      for (const node of graph.nodes) {
        if (!positions.has(node.id)) positions.set(node.id, seedPosition(node.id));
      }

      nodeIds = graph.nodes.map((node) => node.id);
      links = graph.links;
      applyToEngine();
    },

    focus(nodeId: string, sequence: number): void {
      if (!guard("focus")) return;
      if (!positions.has(nodeId)) return; // unknown id: ignore, don't consume the token
      if (sequence <= lastAppliedSequence) return; // stale token: ignore
      lastAppliedSequence = sequence;
      lastFocus = { nodeId, sequence };
      if (engine) {
        const index = nodeIds.indexOf(nodeId);
        if (index >= 0) engine.zoomToPointByIndex(index, 700, 3, true, false);
      }
    },

    resetView(): void {
      if (!guard("resetView")) return;
      if (engine) engine.fitView(250, 0.1, false);
    },

    resize(width: number, height: number): void {
      if (!guard("resize")) return;
      lastSize = { width, height };
      // cosmos measures its own canvas via a ResizeObserver; the container
      // size is the source of truth, so nothing further is needed here.
    },

    onNodeSelect(callback: (nodeId: string) => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    emitNodeSelect(nodeId: string): void {
      dispatch(nodeId);
    },

    getPositions(): ReadonlyMap<string, NodePosition> {
      const snapshot = new Map<string, NodePosition>();
      for (const [nodeId, [x, y]] of positions) {
        // P6: 2D adapter — omit z.
        snapshot.set(nodeId, { x, y });
      }
      return snapshot;
    },

    dispose(): void {
      if (disposed) return; // L4: idempotent
      disposed = true;
      mounted = false;
      if (engine) {
        // GL teardown can race in-flight async callbacks; swallow errors so a
        // clean teardown never becomes an uncaught exception (contract §5 L3).
        try {
          engine.destroy();
        } catch {
          /* best-effort teardown */
        }
        engine = null;
      }
      positions.clear();
      nodeIds = [];
      links = [];
      listeners.clear();
      lastFocus = null;
      lastAppliedSequence = -1;
      lastSize = null;
    },
  };

  return renderer;
}
