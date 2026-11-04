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

import { getRgbaColor, Graph, PointShape } from "@cosmos.gl/graph";
import type { GraphConfig } from "@cosmos.gl/graph";
import { FALLBACK_COLOR, getGroupColor } from "../config";
import { initialViewState } from "../view-state";
import { adoptedCoordinate } from "./renderer";
import type { GraphRenderer, NodePosition, RendererNode, RendererGraph } from "./renderer";

/** A 2D point position (x, y) — the adapter's authoritative per-node layout. */
type Point2D = [number, number];

/** The app's two themes (card C3): dark is the default, "light" is opt-in. */
export type CosmosTheme = "light" | "dark";

/** Construction options for {@link createCosmosRenderer} (card D3 S2). */
export interface CosmosRendererOptions {
  /**
   * Initial theme. Defaults to the theme of the opened URL
   * (`initialViewState.theme`, card C3), matching what Graph.tsx renders —
   * so the canvas background agrees with the app chrome before the host
   * wires its theme switch through {@link CosmosRenderer.setTheme}.
   */
  theme?: CosmosTheme;
}

// Engine background per theme — the exact colours Graph.tsx gives
// ForceGraph3D (`#ffffff` light / `#000000` dark), so an adapter swap never
// flickers a different backdrop. cosmos.gl 3.x renders NO point labels inside
// the engine (there is no label colour in GraphConfig); the hover tooltip is
// host-side (Graph.tsx `labelColor`), so theming that surface stays there.
function backgroundColorFor(theme: CosmosTheme): string {
  return theme === "light" ? "#ffffff" : "#000000";
}

// Point sizes per shape. The legacy 3D view drew grouped nodes as spheres and
// ungrouped nodes as boxes; the 2D analogue is circle vs square (S2). A
// square reads slightly larger than a circle at equal `size`, so ungrouped
// points get one size step down to keep the visual weight comparable.
const GROUPED_SIZE = 8;
const UNGROUPED_SIZE = 7;

/**
 * Extension of the contract with the read-only inspection / host-activation
 * surface described above. A production GraphRenderer consumer sees only
 * `GraphRenderer`; these members exist so the contract suite (and any host
 * picking layer) can drive and observe the adapter headlessly.
 */
export interface CosmosRenderer extends GraphRenderer {
  /**
   * Current theme (S2). Drives the engine background; see
   * {@link CosmosRendererOptions.theme}.
   */
  readonly theme: CosmosTheme;
  /**
   * Switch light/dark at runtime (card D3 S2). Applies immediately to a live
   * engine via `setConfigPartial`; headless mode just records it so a later
   * real mount starts themed. Silent no-op after dispose().
   */
  setTheme(theme: CosmosTheme): void;
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

/** The registry id the app registers this factory under (engines.ts). */
export const COSMOS_RENDERER_ID = "cosmos";

export function createCosmosRenderer(
  id = COSMOS_RENDERER_ID,
  options: CosmosRendererOptions = {}
): CosmosRenderer {
  let mounted = false;
  let disposed = false;
  let headless = true;
  let theme: CosmosTheme = options.theme ?? initialViewState.theme;
  let lastFocus: { nodeId: string; sequence: number } | null = null;
  let lastAppliedSequence = -1;
  let lastSize: { width: number; height: number } | null = null;
  let setCount = 0;

  // Authoritative position memory (contract §2 P1). Survivors keep their
  // entry across set(); new ids are seeded; removed ids are deleted.
  const positions = new Map<string, Point2D>();
  // Current data, in node order (drives index→id mapping for links + clicks).
  let nodeIds: string[] = [];
  // Per-node styling inputs, parallel to nodeIds (card D3 S2): the resolved
  // colour (explicit node.color, else the palette colour for its group) and
  // the raw group ("" / undefined → ungrouped look).
  let nodeColors: string[] = [];
  let nodeGroups: (string | undefined)[] = [];
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

  // CSS colour string → engine RGBA, memoised per string. The palette has a
  // bounded set of colours, so a set() of 25k nodes parses each colour once.
  // getRgbaColor handles hex AND CSS names (FALLBACK_COLOR is "gray"); an
  // unparseable value degrades to the fallback instead of black-on-black.
  const rgbaCache = new Map<string, readonly number[]>();
  function rgbaFor(color: string): readonly number[] {
    let rgba = rgbaCache.get(color);
    if (!rgba) {
      try {
        rgba = getRgbaColor(color);
      } catch {
        rgba = getRgbaColor(FALLBACK_COLOR);
      }
      rgbaCache.set(color, rgba);
    }
    return rgba;
  }

  /** Node colour (S2): explicit node color wins, else the palette group colour. */
  function resolveNodeColor(node: RendererNode): string {
    return node.color ?? getGroupColor(node.group ?? "");
  }

  /** Upload the current data AND styling to the engine (no-op in headless mode). */
  function applyToEngine(): void {
    if (!engine) return;
    const n = nodeIds.length;
    const pointPositions = new Float32Array(n * 2);
    const pointColors = new Float32Array(n * 4);
    const pointSizes = new Float32Array(n);
    const pointShapes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = positions.get(nodeIds[i]);
      if (p) {
        pointPositions[i * 2] = p[0];
        pointPositions[i * 2 + 1] = p[1];
      }
      const rgba = rgbaFor(nodeColors[i] ?? FALLBACK_COLOR);
      pointColors.set(rgba, i * 4);
      // Legacy look (S2): grouped → circle/sphere, ungrouped → square/box.
      const grouped = (nodeGroups[i] ?? "") !== "";
      pointSizes[i] = grouped ? GROUPED_SIZE : UNGROUPED_SIZE;
      pointShapes[i] = grouped ? PointShape.Circle : PointShape.Square;
    }
    const index = new Map(nodeIds.map((nodeId, i) => [nodeId, i] as const));
    const linkPairs = links.filter((link) => index.has(link.source) && index.has(link.target));
    const linkArray = new Float32Array(linkPairs.length * 2);
    const linkColors = new Float32Array(linkPairs.length * 4);
    const colorById = new Map(nodeIds.map((nodeId, i) => [nodeId, nodeColors[i]] as const));
    linkPairs.forEach((link, i) => {
      linkArray[i * 2] = index.get(link.source) as number;
      linkArray[i * 2 + 1] = index.get(link.target) as number;
      // Link colour (S2): source colour, else target colour, else fallback —
      // exactly graph-store.toGraphData's rule.
      const rgba = rgbaFor(
        link.color ?? colorById.get(link.source) ?? colorById.get(link.target) ?? FALLBACK_COLOR
      );
      linkColors.set(rgba, i * 4);
    });
    // `dontRescale: true` — render our positions verbatim (P2/P3).
    engine.setPointPositions(pointPositions, true);
    engine.setPointColors(pointColors);
    engine.setPointSizes(pointSizes);
    engine.setPointShapes(pointShapes);
    engine.setLinks(linkArray);
    engine.setLinkColors(linkColors);
    // Snap, no transition: a data replacement is not an animation.
    engine.render(undefined, 0);
  }

  function engineConfig(onPointClick: (index: number) => void): GraphConfig {
    return {
      // Card D3 S2 styling. Per-node/per-link COLOURS, sizes and shapes are
      // data-driven via setPointColors/setPointSizes/setPointShapes/
      // setLinkColors in applyToEngine; the config below carries the theme
      // background and the defaults those per-item arrays fall back to.
      backgroundColor: backgroundColorFor(theme),
      spaceSize: SPACE_SIZE,
      rescalePositions: false,
      enableSimulation: false,
      pointDefaultSize: GROUPED_SIZE,
      pointDefaultShape: PointShape.Circle,
      // Gray for out-of-range entries; matches FALLBACK_COLOR's look.
      pointDefaultColor: FALLBACK_COLOR,
      linkDefaultWidth: 1,
      linkDefaultColor: FALLBACK_COLOR,
      // Legacy 3D view rendered links at opacity 0.5.
      linkOpacity: 0.5,
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
    get theme() {
      return theme;
    },
    setTheme(next: CosmosTheme): void {
      if (!guard("setTheme")) return;
      if (theme === next) return;
      theme = next;
      if (engine) engine.setConfigPartial({ backgroundColor: backgroundColorFor(theme) });
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
      // P2/P3/P7: survivors keep their exact position; new ids take the
      // handed finite coordinates when present (the D4 engine-switch
      // handoff, CONTRACT.md §2 P7), else a deterministic seed.
      for (const node of graph.nodes) {
        if (positions.has(node.id)) continue;
        const [sx, sy] = seedPosition(node.id);
        positions.set(node.id, [adoptedCoordinate(node.x) ?? sx, adoptedCoordinate(node.y) ?? sy]);
      }

      nodeIds = graph.nodes.map((node) => node.id);
      nodeColors = graph.nodes.map(resolveNodeColor);
      nodeGroups = graph.nodes.map((node) => node.group);
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
      nodeColors = [];
      nodeGroups = [];
      links = [];
      listeners.clear();
      lastFocus = null;
      lastAppliedSequence = -1;
      lastSize = null;
    },
  };

  return renderer;
}
