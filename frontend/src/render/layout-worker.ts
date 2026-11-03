// Card D2 S2 — browser client for the force-atlas2 layout worker.
//
// Owns one layout worker per renderer: startLayout / stopLayout / onTick /
// dispose. Ticks carry a Float32Array snapshot of ALL positions (transferable)
// — the adapter applies them to its own graph (renderer-owned positions,
// CONTRACT.md P1).
//
// Headless tests do NOT use this factory: the adapter accepts an injected
// layoutWorkerFactory (createSigmaRenderer option), and the test script
// provides a node:worker_threads-backed implementation of the same
// LayoutWorkerClient interface against a bundled copy of
// forceatlas2.worker.ts. Keeping this file browser-only is what lets Vite
// bundle it without touching any Node built-in.

import type { ForceAtlas2Settings } from "./forceatlas2";
import type { LayoutTickMessage } from "./forceatlas2.worker";

export const LAYOUT_DEFAULT_ITERATIONS = 300;
export const LAYOUT_DEFAULT_ITERATIONS_PER_TICK = 16;

export interface LayoutRequest {
  /** Node ids in index order (index i ↔ positions[2i], positions[2i+1]). */
  nodes: readonly string[];
  /** Links as [sourceIndex, targetIndex] pairs. */
  links: ReadonlyArray<readonly [number, number]>;
  /** Initial positions (current renderer positions), length 2·nodes.length. */
  positions: Float64Array;
  /** Total iterations (default 300). */
  iterations?: number;
  /** Iterations per posted tick (default 16). */
  iterationsPerTick?: number;
  settings?: Partial<ForceAtlas2Settings>;
}

export interface LayoutTick {
  /** Completed iteration count. */
  iteration: number;
  /** Total iterations of the run. */
  iterations: number;
  /** Float32 positions snapshot, length 2·nodes.length. */
  positions: Float32Array;
  /** True on the final tick of the run. */
  done: boolean;
}

export interface LayoutWorkerClient {
  /** Start (or restart) a layout run. Safe to call while one is live. */
  startLayout(req: LayoutRequest): void;
  /** Ask the worker to stop the current run (the last posted tick stands). */
  stopLayout(): void;
  /** Subscribe to ticks. Returns an unsubscribe function. */
  onTick(cb: (tick: LayoutTick) => void): () => void;
  /** Terminate the worker and drop all subscriptions. Idempotent. */
  dispose(): void;
}

export function createLayoutWorker(): LayoutWorkerClient {
  const tickListeners = new Set<(tick: LayoutTick) => void>();
  let disposed = false;

  const handleMessage = (data: unknown): void => {
    const msg = data as LayoutTickMessage;
    if (msg && msg.type === "layout:tick") {
      for (const cb of tickListeners) cb(msg);
    }
  };

  // Vite resolves this into a separate worker chunk at build time.
  const worker = new Worker(new URL("./forceatlas2.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (ev) => handleMessage(ev.data));

  return {
    startLayout(req: LayoutRequest): void {
      if (disposed) return;
      worker.postMessage({
        type: "layout:start",
        nodes: [...req.nodes],
        links: req.links.map(([a, b]) => [a, b] as [number, number]),
        positions: req.positions,
        iterations: req.iterations ?? LAYOUT_DEFAULT_ITERATIONS,
        iterationsPerTick: req.iterationsPerTick ?? LAYOUT_DEFAULT_ITERATIONS_PER_TICK,
        settings: req.settings,
      });
    },
    stopLayout(): void {
      if (disposed) return;
      worker.postMessage({ type: "layout:stop" });
    },
    onTick(cb: (tick: LayoutTick) => void): () => void {
      tickListeners.add(cb);
      return () => {
        tickListeners.delete(cb);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      tickListeners.clear();
      worker.terminate();
    },
  };
}
