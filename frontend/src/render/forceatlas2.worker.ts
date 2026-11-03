// Card D2 S2 — force-atlas2 Web Worker entry (CONTRACT.md L3: the renderer
// owns its layout ticks and cancels them on dispose()).
//
// Runs the pure, deterministic forceAtlas2 engine (./forceatlas2.ts) off the
// main thread and ships positions back in chunks, so a 2k–10k layout never
// blocks rendering or input (the main thread stays interactive while this
// runs — card S3's 10k interactive check relies on that).
//
// Dual runtime, same protocol:
//   - browser: dedicated Worker (self.onmessage / self.postMessage);
//   - Node (headless tests): node:worker_threads (parentPort), loaded via a
//     lazy, @vite-ignore'd dynamic import so the Vite browser build never
//     resolves the Node built-in.

import {
  createForceAtlas2Session,
  type ForceAtlas2Session,
  type ForceAtlas2Settings,
} from "./forceatlas2";

/** main → worker: start (or restart) a layout run. */
export interface LayoutStartMessage {
  type: "layout:start";
  /** Node ids in index order (index i ↔ positions[2i], positions[2i+1]). */
  nodes: string[];
  /** Links as [sourceIndex, targetIndex] pairs. */
  links: [number, number][];
  /** Initial positions (the renderer's current ones), length 2·nodes.length. */
  positions: Float64Array;
  /** Total iterations for the run. */
  iterations: number;
  /** Iterations computed between two posted ticks (yields the main thread). */
  iterationsPerTick: number;
  settings?: Partial<ForceAtlas2Settings>;
}

/** main → worker: cancel the current run (no further ticks after it ends). */
export interface LayoutStopMessage {
  type: "layout:stop";
}

/** worker → main: a position snapshot after `iterationsPerTick` iterations. */
export interface LayoutTickMessage {
  type: "layout:tick";
  /** Completed iteration count. */
  iteration: number;
  /** Total iterations of this run. */
  iterations: number;
  /** Float32 copy of the positions (transferable). */
  positions: Float32Array;
  /** True on the final tick of the run. */
  done: boolean;
}

export type LayoutIncomingMessage = LayoutStartMessage | LayoutStopMessage;

interface WorkerRuntime {
  onMessage(cb: (msg: LayoutIncomingMessage) => void): void;
  post(msg: LayoutTickMessage, transfer: Transferable[]): void;
}

const globalWithNode = globalThis as { process?: { versions?: { node?: string } } };
const isNodeRuntime = Boolean(globalWithNode.process?.versions?.node);

function browserRuntime(): WorkerRuntime {
  const scope = self as unknown as {
    onmessage: ((e: { data: LayoutIncomingMessage }) => void) | null;
    postMessage(msg: unknown, transfer: Transferable[]): void;
  };
  return {
    onMessage(cb) {
      scope.onmessage = (e) => cb(e.data);
    },
    post(msg, transfer) {
      scope.postMessage(msg, transfer);
    },
  };
}

/** Resolves once the Node worker_threads runtime is loaded (Node branch only). */
function loadNodeRuntime(): Promise<WorkerRuntime> {
  return import(/* @vite-ignore */ "node:worker_threads").then((wt) => {
    if (!wt.parentPort) {
      throw new Error("forceatlas2 worker: no parentPort (not running inside a worker thread)");
    }
    const port = wt.parentPort;
    return {
      onMessage(cb: (msg: LayoutIncomingMessage) => void): void {
        port.on("message", (data: unknown) => cb(data as LayoutIncomingMessage));
      },
      post(msg: LayoutTickMessage, transfer: Transferable[]): void {
        port.postMessage(msg, transfer);
      },
    };
  });
}

let runtime: WorkerRuntime | null = null;
let session: ForceAtlas2Session | null = null;
let loopRunning = false;
let stopRequested = false;

async function runLoop(iterationsPerTick: number): Promise<void> {
  loopRunning = true;
  try {
    // Re-read the global `session` on every pass: a `layout:start` that
    // arrives between chunks replaces the session, and this loop must follow
    // the new run instead of finishing the stale one.
    while (session && !stopRequested && session.iteration < session.totalIterations) {
      session.step(iterationsPerTick);
      // Float64 → Float32 copy for transfer (the worker keeps computing in
      // Float64, so the trajectory stays bit-identical to a direct run).
      const copy = new Float32Array(session.positions);
      const done = session.iteration >= session.totalIterations;
      runtime?.post(
        {
          type: "layout:tick",
          iteration: session.iteration,
          iterations: session.totalIterations,
          positions: copy,
          done,
        },
        [copy.buffer]
      );
      if (done || stopRequested) break;
      // Yield to the message loop so the main thread stays responsive
      // (browser) and stop/start messages are processed between chunks
      // (node:worker_threads).
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    session = null;
    loopRunning = false;
  }
}

function handleMessage(msg: LayoutIncomingMessage): void {
  if (msg.type === "layout:start") {
    session = createForceAtlas2Session(
      { nodes: msg.nodes, links: msg.links, positions: msg.positions },
      msg.iterations,
      msg.settings
    );
    stopRequested = false;
    if (!loopRunning) void runLoop(msg.iterationsPerTick);
    return;
  }
  if (msg.type === "layout:stop") {
    stopRequested = true;
  }
}

if (isNodeRuntime) {
  // The runtime promise resolves before any message can be delivered, so
  // `runtime` is always set by the time handleMessage runs.
  void loadNodeRuntime().then((rt) => {
    runtime = rt;
    rt.onMessage(handleMessage);
  });
} else {
  const rt = browserRuntime();
  runtime = rt;
  rt.onMessage(handleMessage);
}
