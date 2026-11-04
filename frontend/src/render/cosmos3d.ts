// cosmos.gl in its NATIVE mode — a live 3D GPU force simulation.
//
// Why this exists next to the 2D `cosmos` adapter (card D3): the D3 card
// built cosmos as a deterministic, simulation-OFF 2D renderer (position
// memory, CONTRACT.md §2). That satisfies the switch-stability contract but
// renders the flat, static map — not what cosmos.gl is for. The owner
// directive names the cosmos.gl gallery experience (3D, live forces, orbit
// camera) as the app's showcase renderer over real HKG entity data, so this
// adapter runs the engine's OWN simulation in 3D.
//
// Contract posture (CONTRACT.md §2, deliberate deviations documented here):
//  - Positions are [x, y, z] — the contract's optional `z` IS filled
//    (renderer.ts: "3D adapters must fill it").
//  - P2/P3 (exact survivors, deterministic seeds) hold only as START
//    positions: with the simulation ON the engine legitimately moves
//    everything — that is the product behaviour. `getPositions()` therefore
//    READS BACK the live engine layout, so an engine switch (P5/P7) hands
//    the 2D renderers the positions actually on screen.
//  - startLayout/stopLayout map to enableSimulation on/off (supportsLayout
//    is true; the data effect starts a layout run whenever the store grows).
//
// Dual-mode headless verification mirrors cosmos.ts: a null / non-DOM
// container (the Node contract tests) or a failed WebGL context degrades to
// a state-only renderer over the same position map — no GL canvas, every
// contract method still works.

import { getRgbaColor, Graph, PointShape } from "@cosmos.gl/graph";
import type { GraphConfig } from "@cosmos.gl/graph";
import { FALLBACK_COLOR, getGroupColor } from "../config";
import { initialViewState } from "../view-state";
import { adoptedCoordinate } from "./renderer";
import type { GraphRenderer, NodePosition, RendererNode, RendererGraph } from "./renderer";

/** A 3D point position (x, y, z) — cosmos.gl's native space. */
type Point3D = [number, number, number];

export type Cosmos3dTheme = "light" | "dark";

export interface Cosmos3dRendererOptions {
  theme?: Cosmos3dTheme;
}

/** Same theme palette as the 2D cosmos adapter (no flicker on a switch). */
function backgroundColorFor(theme: Cosmos3dTheme): string {
  return theme === "light" ? "#ffffff" : "#000000";
}

const GROUPED_SIZE = 10;
const UNGROUPED_SIZE = 8;

export interface Cosmos3dRenderer extends GraphRenderer {
  readonly theme: Cosmos3dTheme;
  setTheme(theme: Cosmos3dTheme): void;
  emitNodeSelect(nodeId: string): void;
  readonly lastFocus: { nodeId: string; sequence: number } | null;
  readonly lastSize: { width: number; height: number } | null;
  readonly setCount: number;
  readonly mounted: boolean;
  readonly disposed: boolean;
  readonly headless: boolean;
  /** True while the engine simulation is enabled (3D motion ON). */
  readonly simulating: boolean;
  /** Layout run = the GPU simulation itself (no external worker). */
  startLayout(): void;
  stopLayout(): void;
  readonly layoutRunning: boolean;
}

// Seed space mirrors the 2D adapter's world size; the 3rd axis gets the same
// span so a fresh graph occupies a cube, not a pancake.
const SPACE_SIZE = 4096;
const SPAN = 4000;

/** djb2 — same hash as the 2D adapter (a carried xy pair stays coherent). */
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

/** Deterministic 3D seed for a node id: same id → same START point. */
function seedPosition(nodeId: string): Point3D {
  const random = mulberry32(djb2(nodeId));
  return [random() * SPAN, random() * SPAN, random() * SPAN];
}

/** True when `container` is a genuine DOM element (not null / a test stub). */
function isDomElement(container: unknown): container is HTMLElement {
  return typeof container === "object" && container !== null && "nodeType" in container;
}

/** The registry id the app registers this factory under (engines.ts). */
export const COSMOS3D_RENDERER_ID = "cosmos3d";

export function createCosmos3dRenderer(
  id = COSMOS3D_RENDERER_ID,
  options: Cosmos3dRendererOptions = {}
): Cosmos3dRenderer {
  let mounted = false;
  let disposed = false;
  let headless = true;
  let simulating = true;
  let theme: Cosmos3dTheme = options.theme ?? initialViewState.theme;
  let lastFocus: { nodeId: string; sequence: number } | null = null;
  let lastAppliedSequence = -1;
  let lastSize: { width: number; height: number } | null = null;
  let setCount = 0;

  // Our own position bookkeeping: seeds and carried handoffs. Once the
  // engine is live, getPositions() PREFERS the engine's read-back — this
  // map is the fallback and the headless truth.
  const positions = new Map<string, Point3D>();
  let nodeIds: string[] = [];
  let nodeColors: string[] = [];
  let nodeGroups: (string | undefined)[] = [];
  let links: RendererGraph["links"] = [];
  const listeners = new Set<(nodeId: string) => void>();

  let engine: Graph | null = null;

  function guard(op: string): boolean {
    if (disposed) return false;
    if (!mounted) throw new Error(`renderer "${id}": ${op} before mount`);
    return true;
  }

  function dispatch(nodeId: string): void {
    if (disposed) return;
    for (const listener of listeners) listener(nodeId);
  }

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

  function resolveNodeColor(node: RendererNode): string {
    return node.color ?? getGroupColor(node.group ?? "");
  }

  /** Upload data + styling; positions are START positions for the sim. */
  function applyToEngine(): void {
    if (!engine) return;
    const n = nodeIds.length;
    const pointPositions = new Float32Array(n * 3);
    const pointColors = new Float32Array(n * 4);
    const pointSizes = new Float32Array(n);
    const pointShapes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = positions.get(nodeIds[i]);
      if (p) {
        pointPositions[i * 3] = p[0];
        pointPositions[i * 3 + 1] = p[1];
        pointPositions[i * 3 + 2] = p[2];
      }
      const rgba = rgbaFor(nodeColors[i] ?? FALLBACK_COLOR);
      pointColors.set(rgba, i * 4);
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
      const rgba = rgbaFor(
        link.color ?? colorById.get(link.source) ?? colorById.get(link.target) ?? FALLBACK_COLOR
      );
      linkColors.set(rgba, i * 4);
    });
    // Rescale allowed: the simulation owns the final layout.
    engine.setPointPositions(pointPositions);
    engine.setPointColors(pointColors);
    engine.setPointSizes(pointSizes);
    engine.setPointShapes(pointShapes);
    engine.setLinks(linkArray);
    engine.setLinkColors(linkColors);
    engine.render();
  }

  /** Live engine layout read-back merged over our map (3D truth). */
  function livePositions(): ReadonlyMap<string, Point3D> {
    if (!engine) return positions;
    try {
      const flat = engine.getPointPositions(); // [x0,y0,z0, x1,...]
      if (flat.length >= nodeIds.length * 3) {
        for (let i = 0; i < nodeIds.length; i++) {
          const x = flat[i * 3];
          const y = flat[i * 3 + 1];
          const z = flat[i * 3 + 2];
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            positions.set(nodeIds[i], [x, y, z]);
          }
        }
      }
    } catch {
      // Engine not ready / disposed mid-call: fall back to our map.
    }
    return positions;
  }

  function engineConfig(onPointClick: (index: number) => void): GraphConfig {
    return {
      // cosmos.gl's showcase behaviour: the engine's own force simulation
      // runs on the GPU in 3D (this is what the 2D adapter disables).
      enableSimulation: true,
      spaceSize: SPACE_SIZE,
      backgroundColor: backgroundColorFor(theme),
      pointDefaultSize: GROUPED_SIZE,
      pointDefaultShape: PointShape.Circle,
      pointDefaultColor: FALLBACK_COLOR,
      linkDefaultWidth: 1,
      linkDefaultColor: FALLBACK_COLOR,
      linkOpacity: 0.6,
      linkDefaultArrows: false,
      enableDrag: true,
      // Gentle centering so a growing exploration stays around the root.
      simulationCenter: 1,
      // Empty string hides cosmos.gl's "Powered by cosmos.gl" label.
      attribution: "",
      onPointClick,
    };
  }

  const renderer: Cosmos3dRenderer = {
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
    get simulating() {
      return simulating;
    },
    get layoutRunning() {
      return simulating;
    },
    get theme() {
      return theme;
    },
    setTheme(next: Cosmos3dTheme): void {
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
          engine = new Graph(
            container as HTMLDivElement,
            engineConfig((index) => {
              const nodeId = nodeIds[index];
              if (nodeId !== undefined) dispatch(nodeId);
            })
          );
          headless = false;
          engine.ready.then(() => {
            if (mounted && !disposed) applyToEngine();
          });
        } catch (err) {
          console.warn(`renderer "${id}": WebGL init failed, running headless`, err);
          engine = null;
          headless = true;
        }
      }
    },

    set(graph: RendererGraph): void {
      if (!guard("set")) return;
      setCount += 1;

      const present = new Set(graph.nodes.map((node) => node.id));
      for (const gone of [...positions.keys()]) {
        if (!present.has(gone)) positions.delete(gone);
      }
      // Survivors keep their position (P2 — until the sim moves them);
      // new ids take handed xyz (engine-switch handoff, P7), else a seed.
      for (const node of graph.nodes) {
        if (positions.has(node.id)) continue;
        const [sx, sy, sz] = seedPosition(node.id);
        positions.set(node.id, [
          adoptedCoordinate(node.x) ?? sx,
          adoptedCoordinate(node.y) ?? sy,
          adoptedCoordinate(node.z) ?? sz,
        ]);
      }

      nodeIds = graph.nodes.map((node) => node.id);
      nodeColors = graph.nodes.map(resolveNodeColor);
      nodeGroups = graph.nodes.map((node) => node.group);
      links = graph.links;
      applyToEngine();
    },

    /** Layout run = the GPU simulation (already running; re-enable it). */
    startLayout(): void {
      if (!guard("startLayout")) return;
      simulating = true;
      if (engine) engine.setConfigPartial({ enableSimulation: true });
    },

    stopLayout(): void {
      if (!guard("stopLayout")) return;
      simulating = false;
      if (engine) engine.setConfigPartial({ enableSimulation: false });
    },

    focus(nodeId: string, sequence: number): void {
      if (!guard("focus")) return;
      if (!positions.has(nodeId)) return;
      if (sequence <= lastAppliedSequence) return;
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
      // cosmos.gl observes its container itself (ResizeObserver).
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
      const live = livePositions();
      const snapshot = new Map<string, NodePosition>();
      for (const [nodeId, [x, y, z]] of live) {
        snapshot.set(nodeId, { x, y, z }); // 3D adapter: z is filled
      }
      return snapshot;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      mounted = false;
      if (engine) {
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
