// Card D2 S2 — force-atlas2 worker + sigma adapter integration test.
//
// Covers the three layers of the S2 seam:
//   1. the pure engine (src/render/forceatlas2.ts): determinism, invariants,
//      and the degenerate-input regression (fully coincident start — the
//      quadtree must stay finite and fast, no hang, no blow-up);
//   2. the worker transport (forceatlas2.worker.ts via node:worker_threads —
//      the SAME protocol the browser Worker uses): chunked ticks, done flag,
//      stop, and trajectory agreement with a direct engine run;
//   3. the sigma adapter seam: startLayout() runs the layout in the adapter's
//      own worker and applies ticks to its graph; dispose() mid-run cancels
//      the run and terminates the worker (CONTRACT.md L3); startLayout before
//      mount throws (L2).
//
// Run: npm run test (the runner bundles forceatlas2.worker.ts and points
// FORCEATLAS2_WORKER_PATH at the bundle).

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";

import { FakeElement, fakeDom, flushRaf } from "./fake-dom";
import type { FakeDomHandle } from "./fake-dom";
import { makeTwoThousandNodeGraph } from "./fixtures/cosmos-two-thousand";
import { createForceAtlas2Session, runForceAtlas2 } from "../src/render/forceatlas2";
import type { LayoutRequest, LayoutTick, LayoutWorkerClient } from "../src/render/layout-worker";
import { seedPosition2D } from "../src/render/seeding";
import { createSigmaRenderer } from "../src/render/sigma";

const dom: FakeDomHandle = fakeDom;
const makeContainer = () => new FakeElement("DIV") as unknown as HTMLElement;

// ---------------------------------------------------------------- helpers

const WORKER_PATH = process.env.FORCEATLAS2_WORKER_PATH;
assert.ok(WORKER_PATH, "FORCEATLAS2_WORKER_PATH must be set by the test runner");

/**
 * node:worker_threads implementation of the LayoutWorkerClient interface —
 * the transport the browser's createLayoutWorker() uses, against a bundled
 * copy of the SAME worker entry. The adapter under test cannot tell the
 * difference (it only ever sees the interface).
 */
function createNodeLayoutWorker(): LayoutWorkerClient {
  const worker = new Worker(WORKER_PATH, { type: "module" });
  const tickListeners = new Set<(tick: LayoutTick) => void>();
  worker.on("message", (data: unknown) => {
    const msg = data as { type?: string } & LayoutTick;
    if (msg && msg.type === "layout:tick") {
      for (const cb of tickListeners) cb(msg);
    }
  });
  let disposed = false;
  return {
    startLayout(req: LayoutRequest): void {
      if (disposed) return;
      worker.postMessage({
        type: "layout:start",
        nodes: [...req.nodes],
        links: req.links.map(([a, b]) => [a, b] as [number, number]),
        positions: req.positions,
        iterations: req.iterations ?? 300,
        iterationsPerTick: req.iterationsPerTick ?? 16,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

/** The 2k fixture as engine input: id list + index-pair links. */
function layoutInput(ids: readonly string[]): {
  nodes: string[];
  links: [number, number][];
  positions: Float64Array;
} {
  const { links } = makeTwoThousandNodeGraph();
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const linkPairs: [number, number][] = [];
  for (const l of links) {
    const s = indexOf.get(l.source);
    const t = indexOf.get(l.target);
    if (s !== undefined && t !== undefined) linkPairs.push([s, t]);
  }
  const positions = new Float64Array(2 * ids.length);
  ids.forEach((id, i) => {
    const seed = seedPosition2D(id);
    positions[2 * i] = seed.x;
    positions[2 * i + 1] = seed.y;
  });
  return { nodes: [...ids], links: linkPairs, positions };
}

const { nodes: FIXTURE_NODES, links: FIXTURE_LINKS } = makeTwoThousandNodeGraph();
const FIXTURE_IDS = FIXTURE_NODES.map((n) => n.id);

// ------------------------------------------------------------------ engine

test("D2-S2: forceAtlas2 engine is deterministic (bit-identical) on the 2k fixture", () => {
  const a = layoutInput(FIXTURE_IDS);
  const b = layoutInput(FIXTURE_IDS);
  const t0 = performance.now();
  runForceAtlas2(a, 120);
  runForceAtlas2(b, 120);
  const ms = performance.now() - t0;
  for (let i = 0; i < a.positions.length; i++) {
    assert.equal(a.positions[i], b.positions[i], `position ${i} must be bit-identical`);
  }
  console.log(`  [D2-S2] engine 2×2k×120iters: ${ms.toFixed(0)}ms, bit-identical`);
});

test("D2-S2: forceAtlas2 engine invariants — finite, centered, actually moves", () => {
  const input = layoutInput(FIXTURE_IDS);
  const before = new Float64Array(input.positions);
  runForceAtlas2(input, 200);
  const n = FIXTURE_IDS.length;
  let cx = 0;
  let cy = 0;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const x = input.positions[2 * i];
    const y = input.positions[2 * i + 1];
    assert.ok(Number.isFinite(x) && Number.isFinite(y), "positions must stay finite");
    cx += x;
    cy += y;
    if (Math.hypot(x - before[2 * i], y - before[2 * i + 1]) > 1e-6) moved++;
  }
  cx /= n;
  cy /= n;
  // The engine operates in centered space: the mass-weighted centre of mass
  // is driven to the origin (the paper's invariant, up to cooling tails).
  assert.ok(Math.abs(cx) < 0.5 && Math.abs(cy) < 0.5, `centre of mass near origin: ${cx},${cy}`);
  // A connected graph must actually be laid out, not frozen.
  assert.ok(moved > n * 0.9, `expected most nodes to move, ${moved}/${n} moved`);
});

test("D2-S2: forceAtlas2 engine survives a fully degenerate start (no hang, no blow-up)", () => {
  // 50 nodes, ONE shared point, ring links: the worst case for the quadtree
  // (exact coincident positions, zero-extent bounding box). Regression guard
  // for the unbounded-subdivision / memory blow-up found while building S2.
  const n = 50;
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const links: [number, number][] = Array.from({ length: n }, (_, i) => [i, (i + 1) % n]);
  const positions = new Float64Array(2 * n); // all zeros
  const t0 = performance.now();
  const session = createForceAtlas2Session({ nodes: ids, links, positions }, 10);
  session.step(10);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `degenerate layout took ${ms.toFixed(0)}ms — suspiciously slow`);
  for (let i = 0; i < positions.length; i++) {
    assert.ok(Number.isFinite(positions[i]), "degenerate layout must stay finite");
  }
  console.log(`  [D2-S2] degenerate 50-at-origin ×10iters: ${ms.toFixed(1)}ms`);
});

// ------------------------------------------------------------------ worker

test("D2-S2: layout worker posts chunked ticks; final tick matches a direct engine run", async () => {
  const input = layoutInput(FIXTURE_IDS);
  const client = createNodeLayoutWorker();
  const ticks: LayoutTick[] = [];
  const unsub = client.onTick((t) => ticks.push(t));
  try {
    client.startLayout({
      nodes: input.nodes,
      links: input.links,
      positions: input.positions,
      iterations: 64,
      iterationsPerTick: 16,
    });
    await waitFor(
      () => ticks.length > 0 && ticks[ticks.length - 1].done,
      30_000,
      "final worker tick"
    );
    // 64 iters ÷ 16 per tick = exactly 4 ticks, last one flagged done.
    assert.equal(ticks.length, 4, "expected 4 ticks for 64 iterations");
    const last = ticks[ticks.length - 1];
    assert.equal(last.done, true);
    assert.equal(last.iteration, 64);
    assert.equal(last.iterations, 64);
    assert.ok(last.positions instanceof Float32Array, "ticks carry a Float32Array");
    assert.equal(last.positions.length, 2 * FIXTURE_IDS.length);
    for (const v of last.positions)
      assert.ok(Number.isFinite(v), "worker positions must be finite");

    // Trajectory agreement: the worker computes in Float64 exactly like the
    // direct engine (only the posted snapshot is rounded to Float32).
    const direct = layoutInput(FIXTURE_IDS);
    runForceAtlas2(direct, 64);
    let maxRel = 0;
    for (let i = 0; i < direct.positions.length; i++) {
      const d = Math.abs(last.positions[i] - direct.positions[i]);
      maxRel = Math.max(maxRel, d / Math.max(Math.abs(direct.positions[i]), 1e-9));
    }
    assert.ok(maxRel < 1e-4, `worker vs engine max relative diff ${maxRel} (Float32 bound)`);
    console.log(`  [D2-S2] worker 2k×64iters: 4 ticks, maxRelDiff=${maxRel.toExponential(2)}`);
  } finally {
    unsub();
    client.dispose();
  }
});

test("D2-S2: layout worker stopLayout() halts the run", async () => {
  const input = layoutInput(FIXTURE_IDS);
  const client = createNodeLayoutWorker();
  const ticks: LayoutTick[] = [];
  const unsub = client.onTick((t) => ticks.push(t));
  try {
    client.startLayout({
      nodes: input.nodes,
      links: input.links,
      positions: input.positions,
      iterations: 300,
      iterationsPerTick: 16,
    });
    await waitFor(() => ticks.length >= 1, 30_000, "first worker tick");
    const seenAtStop = ticks.length;
    client.stopLayout();
    await sleep(300); // give any (incorrect) further ticks a chance to arrive
    assert.ok(ticks.length >= seenAtStop && ticks.length < 300 / 16, "run must be halted");
    for (const t of ticks) assert.equal(t.done, false, "a stopped run never posts done=true");
  } finally {
    unsub();
    client.dispose();
  }
});

// --------------------------------------------------------------- adapter

test("D2-S2: sigma startLayout() runs the 2k layout in the worker and applies ticks", async () => {
  const container = makeContainer();
  const renderer = createSigmaRenderer("sigma", { layoutWorkerFactory: createNodeLayoutWorker });
  renderer.mount(container);
  try {
    dom.reset();
    renderer.set({ nodes: FIXTURE_NODES, links: FIXTURE_LINKS });
    flushRaf();
    const seeds = new Map(renderer.getPositions());

    renderer.startLayout({ iterations: 64, iterationsPerTick: 16 });
    assert.equal(renderer.layoutRunning, true, "layoutRunning must be true while in flight");
    await waitFor(() => !renderer.layoutRunning, 60_000, "layout completion");
    assert.equal(renderer.layoutRunning, false);

    const final = renderer.getPositions();
    assert.equal(final.size, FIXTURE_IDS.length);
    let moved = 0;
    for (const [id, pos] of final) {
      assert.ok(
        Number.isFinite(pos.x) && Number.isFinite(pos.y),
        `${id} must be finite after layout`
      );
      const s = seeds.get(id);
      if (s && Math.hypot(pos.x - s.x, pos.y - s.y) > 1e-6) moved++;
    }
    assert.ok(moved > FIXTURE_IDS.length * 0.9, `layout must move most nodes, ${moved} moved`);
    console.log(`  [D2-S2] sigma 2k layout in worker: ${moved}/${FIXTURE_IDS.length} nodes moved`);
  } finally {
    renderer.dispose();
  }
});

test("D2-S2: sigma dispose() mid-layout cancels the run and terminates the worker", async () => {
  const container = makeContainer();
  let workerDisposed = false;
  const factory = (): LayoutWorkerClient => {
    const client = createNodeLayoutWorker();
    const origDispose = client.dispose.bind(client);
    return {
      ...client,
      dispose: () => {
        workerDisposed = true;
        origDispose();
      },
    };
  };
  const renderer = createSigmaRenderer("sigma", { layoutWorkerFactory: factory });
  renderer.mount(container);
  renderer.set({ nodes: FIXTURE_NODES, links: FIXTURE_LINKS });
  flushRaf();
  const seeds = new Map(renderer.getPositions());

  renderer.startLayout({ iterations: 300, iterationsPerTick: 16 });
  // Wait for at least one tick to land (layout genuinely in flight).
  await waitFor(
    () => {
      for (const [id, pos] of renderer.getPositions()) {
        const s = seeds.get(id);
        if (s && Math.hypot(pos.x - s.x, pos.y - s.y) > 1e-6) return true;
      }
      return false;
    },
    30_000,
    "first tick applied"
  );
  renderer.dispose(); // L3: must cancel the run + terminate the worker

  assert.equal(workerDisposed, true, "dispose() must terminate the layout worker");
  assert.deepEqual([...renderer.getPositions()], [], "getPositions after dispose is empty (L3)");
  // No crash on double-dispose (L4) and on post-dispose calls (silent no-op).
  renderer.dispose();
  renderer.stopLayout();
  assert.doesNotThrow(() => renderer.startLayout());
});

test("D2-S2: sigma startLayout() before mount throws (L2)", () => {
  const renderer = createSigmaRenderer();
  assert.throws(() => renderer.startLayout(), /before mount/);
  assert.equal(renderer.layoutRunning, false);
});
