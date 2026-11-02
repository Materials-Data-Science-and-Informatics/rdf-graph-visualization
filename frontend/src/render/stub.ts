// Headless reference adapter (card D1, CONTRACT.md §7).
//
// Implements GraphRenderer in plain memory — no canvas, no layout engine — so
// the contract test (scripts/render-contract.test.ts) can run the full
// positions/state contract in Node, and real adapters (D2 sigma, D3
// cosmos.gl) get a reference implementation to check themselves against.
//
// Behavior worth copying:
//   - positions: deterministic per node id (hash-seeded), remembered across
//     set() calls for surviving ids, released for removed ids;
//   - focus: applied only on strictly increasing sequence, unknown ids no-op;
//   - lifecycle: data methods throw before mount, no-op after dispose;
//   - events: onNodeSelect delivers synchronously, stops after dispose.

import type { GraphRenderer, NodePosition, RendererGraph } from "./renderer";

/** Test hooks beyond the contract — a real adapter has none of these. */
export interface StubRenderer extends GraphRenderer {
  /** Simulate a user activating a node (delivers onNodeSelect). No-op after dispose. */
  emitNodeSelect(nodeId: string): void;
  /** Last focus request actually APPLIED (stale/unknown requests don't count). */
  lastFocus: { nodeId: string; sequence: number } | null;
  /** Last resize() dimensions, or null. */
  lastSize: { width: number; height: number } | null;
  /** Number of set() calls that were actually applied. */
  setCount: number;
  readonly mounted: boolean;
  readonly disposed: boolean;
}

const SPAN = 100; // positions land in [0, SPAN)

/** djb2 — small, fast, good enough to seed a per-id PRNG. */
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

/** Deterministic initial position for a node id: same id → same point. */
export function seedPosition(nodeId: string): NodePosition {
  const random = mulberry32(djb2(nodeId));
  return {
    x: random() * SPAN,
    y: random() * SPAN,
    z: random() * SPAN,
  };
}

export function createStubRenderer(id = "stub"): StubRenderer {
  let mounted = false;
  let disposed = false;
  let lastFocus: { nodeId: string; sequence: number } | null = null;
  let lastAppliedSequence = -1;
  let lastSize: { width: number; height: number } | null = null;
  let setCount = 0;
  const positions = new Map<string, NodePosition>();
  const listeners = new Set<(nodeId: string) => void>();

  // Returns true when the operation may proceed. Post-dispose it returns
  // false (silent no-op, contract §5); before mount it throws (L2).
  // NOTE: a *void* guard here is a real bug — the calling method must branch
  // on the returned flag, otherwise "no-op after dispose" silently re-runs
  // the body (re-seeding positions / resizing after teardown).
  function guard(op: string): boolean {
    if (disposed) return false;
    if (!mounted) throw new Error(`renderer "${id}": ${op} before mount`);
    return true;
  }

  const renderer: StubRenderer = {
    get id() {
      return id;
    },
    get mounted() {
      return mounted;
    },
    get disposed() {
      return disposed;
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

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- headless stub: the container is part of the contract but unused
    mount(_container: HTMLElement): void {
      if (disposed) return;
      if (mounted) throw new Error(`renderer "${id}": already mounted`);
      mounted = true;
    },

    set(graph: RendererGraph): void {
      if (!guard("set")) return;
      setCount += 1;
      // P4: release state for nodes that vanished.
      for (const gone of [...positions.keys()]) {
        if (!graph.nodes.some((n) => n.id === gone)) positions.delete(gone);
      }
      // P2/P3: survivors keep their positions; new ones get seeded positions.
      for (const node of graph.nodes) {
        if (!positions.has(node.id)) positions.set(node.id, seedPosition(node.id));
      }
    },

    focus(nodeId: string, sequence: number): void {
      if (!guard("focus")) return;
      if (!positions.has(nodeId)) return; // unknown id: ignore
      if (sequence <= lastAppliedSequence) return; // stale token: ignore
      lastAppliedSequence = sequence;
      lastFocus = { nodeId, sequence };
    },

    resetView(): void {
      if (!guard("resetView")) return;
    },

    resize(width: number, height: number): void {
      if (!guard("resize")) return;
      lastSize = { width, height };
    },

    onNodeSelect(callback: (nodeId: string) => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    emitNodeSelect(nodeId: string): void {
      if (disposed) return; // no callbacks after dispose (contract §5)
      for (const listener of listeners) listener(nodeId);
    },

    getPositions(): ReadonlyMap<string, NodePosition> {
      return new Map(positions);
    },

    dispose(): void {
      disposed = true;
      mounted = false;
      positions.clear();
      listeners.clear();
      lastFocus = null;
      lastSize = null;
    },
  };

  return renderer;
}
