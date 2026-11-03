// Card D2 S3 — 10k-node headless interactive check for the sigma adapter.
//
// Ingests the deterministic 10k fixture (scripts/fixtures/ten-thousand.ts)
// through the GraphRenderer contract on the fake DOM and proves the same
// behaviours the 2k check does, AT SCALE:
//   - set(10k) → finite 2D positions for every node (P3 seeding holds at
//     10k) and sigma actually rasterises (WebGL draw/buffer counts);
//   - a perf budget on the synchronous set() call (measured + logged);
//   - selection still resolves a SPECIFIC node among 10k (sigma's real
//     picking decodes the armed index → graph-order node id);
//   - focus() reaches a deep node with the V2 sequence gate intact, and
//     resetView() fits the 10k bounding box without NaN (V1–V3 at scale);
//   - a short layout run (≤32 iterations) through the real layout worker
//     stays finite and finishes inside a generous timeout.
//
// Run: npm run test (the runner bundles forceatlas2.worker.ts and points
// FORCEATLAS2_WORKER_PATH at it, exactly as the S2 layout tests need).

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { test } from "node:test";

import { FakeElement, fakeDom, flushRaf, glCounts } from "./fake-dom";
import type { FakeDomHandle } from "./fake-dom";
import { TEN_THOUSAND_SCALE, makeTenThousandNodeGraph } from "./fixtures/ten-thousand";
import type { LayoutRequest, LayoutTick, LayoutWorkerClient } from "../src/render/layout-worker";
import { createSigmaRenderer } from "../src/render/sigma";
import type { SigmaRenderer } from "../src/render/sigma";

const dom: FakeDomHandle = fakeDom;
const makeContainer = () => new FakeElement("DIV") as unknown as HTMLElement;

const WORKER_PATH = process.env.FORCEATLAS2_WORKER_PATH;
assert.ok(WORKER_PATH, "FORCEATLAS2_WORKER_PATH must be set by the test runner");

/**
 * node:worker_threads LayoutWorkerClient (same transport the browser uses).
 * Intentionally a local copy of the render-layout.test.ts helper rather
 * than a shared module: run-contract-tests bundles each render-*.test.ts
 * entry independently (esbuild inlines shared modules into every bundle
 * anyway), and a new shared helper would mean editing a committed sibling
 * file in a tree shared with sibling cards. If a third consumer appears,
 * extract it then.
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
    await sleep(25);
  }
}

function mount10k(renderer: SigmaRenderer, container: HTMLElement): number {
  const { nodes, links } = makeTenThousandNodeGraph();
  renderer.mount(container);
  dom.reset();
  renderer.set({ nodes, links });
  flushRaf();
  return nodes.length;
}

// Deep-node picking: the 2k check relies on graph order (node-i is item i+1,
// index starts at 1). Same holds at 10k for the ring fixture — nodes are
// added in id order. node-8888 → item index 8889.
const DEEP_INDEX = 8889;
const DEEP_NODE = `node-${DEEP_INDEX - 1}`;

test("D2-S3: set(10k) yields finite 2D positions and real draw calls", () => {
  const container = makeContainer();
  const renderer = createSigmaRenderer();
  const NODES = mount10k(renderer, container);
  assert.equal(NODES, 2000 * TEN_THOUSAND_SCALE);
  assert.equal(NODES, 10000);
  try {
    const positions = renderer.getPositions();
    assert.equal(positions.size, NODES);
    for (const [id, pos] of positions) {
      assert.ok(Number.isFinite(pos.x), `${id}.x must be finite`);
      assert.ok(Number.isFinite(pos.y), `${id}.y must be finite`);
      assert.equal(pos.z, undefined, "2D adapter must not emit z (P6)");
    }
    assert.ok(glCounts.drawCalls > 0, "sigma must have issued draw calls at 10k");
    assert.ok(glCounts.bufferData > 0, "sigma must have uploaded geometry at 10k");
    console.log(
      `  [D2-S3-10k] positions=${positions.size}, drawCalls=${glCounts.drawCalls}, ` +
        `bufferData=${glCounts.bufferData}`
    );
  } finally {
    renderer.dispose();
  }
});

test("D2-S3: headless set(10k) stays inside the perf budget", () => {
  const renderer = createSigmaRenderer();
  renderer.mount(makeContainer());
  try {
    dom.reset();
    const { nodes, links } = makeTenThousandNodeGraph();
    const t0 = performance.now();
    renderer.set({ nodes, links });
    const setMs = performance.now() - t0;
    flushRaf();
    // Budget: synchronous 10k ingest < 3s. The 2k ingest runs in ~50ms; 10k
    // is a linear graph diff (add/drop + attribute merges) plus the first
    // scene/picking build, comfortably under a 3s wall. Bump only with a
    // measured justification here.
    console.log(`  [D2-S3-10k] set(10k): ${setMs.toFixed(1)}ms (budget 3000ms)`);
    assert.ok(setMs < 3000, `set(10k) took ${setMs.toFixed(0)}ms — over the 3000ms budget`);
  } finally {
    renderer.dispose();
  }
});

test("D2-S3: selection resolves a specific node among 10k", () => {
  const container = makeContainer();
  const renderer = createSigmaRenderer();
  mount10k(renderer, container);
  try {
    const seen: string[] = [];
    renderer.onNodeSelect((nodeId) => seen.push(nodeId));
    flushRaf(); // refresh the 10k picking table
    dom.armPickingIndex(DEEP_INDEX);
    try {
      const canvas = dom.findMouseCanvas(container as unknown as FakeElement);
      dom.dispatchClick(canvas, 1, 1);
    } finally {
      dom.clearArmedPixel();
    }
    assert.deepEqual(seen, [DEEP_NODE], `picking must decode ${DEEP_NODE} among 10k`);
  } finally {
    renderer.dispose();
  }
});

test("D2-S3: focus() and resetView() work on a deep node at 10k (V1-V3)", () => {
  const renderer = createSigmaRenderer();
  mount10k(renderer, makeContainer());
  try {
    // V1/V2: focus a deep node; the strictly-increasing gate applies at scale.
    renderer.focus(DEEP_NODE, 1);
    renderer.focus(DEEP_NODE, 1); // stale: ignored
    assert.deepEqual(renderer.lastFocus, { nodeId: DEEP_NODE, sequence: 1 });
    renderer.focus(DEEP_NODE, 2); // advances
    assert.deepEqual(renderer.lastFocus, { nodeId: DEEP_NODE, sequence: 2 });

    // V2: unknown id is a no-op that does not consume the token.
    renderer.focus("node-does-not-exist", 3);
    assert.deepEqual(renderer.lastFocus, { nodeId: DEEP_NODE, sequence: 2 });

    // V3: fit-all over the 10k bounding box — no throw, camera stays finite.
    assert.doesNotThrow(() => {
      renderer.resetView();
      flushRaf();
    });
    const cam = renderer.getCameraState();
    assert.ok(cam && Number.isFinite(cam.x) && Number.isFinite(cam.y) && cam.ratio > 0);
  } finally {
    renderer.dispose();
  }
});

test("D2-S3: a short layout run (<=32 iters) at 10k stays finite and finishes", async () => {
  const container = makeContainer();
  const renderer = createSigmaRenderer("sigma", { layoutWorkerFactory: createNodeLayoutWorker });
  const NODES = mount10k(renderer, container);
  try {
    const seeds = new Map(renderer.getPositions());
    renderer.startLayout({ iterations: 32, iterationsPerTick: 16 });
    assert.equal(renderer.layoutRunning, true);
    // Generous ceiling: 32 iterations of Barnes-Hut over 10k nodes.
    await waitFor(() => !renderer.layoutRunning, 60_000, "10k short layout to finish");
    assert.equal(renderer.layoutRunning, false);

    const final = renderer.getPositions();
    assert.equal(final.size, NODES);
    let moved = 0;
    for (const [id, pos] of final) {
      assert.ok(
        Number.isFinite(pos.x) && Number.isFinite(pos.y),
        `${id} must be finite after 10k layout`
      );
      const s = seeds.get(id);
      if (s && Math.hypot(pos.x - s.x, pos.y - s.y) > 1e-6) moved++;
    }
    console.log(`  [D2-S3-10k] short layout moved ${moved}/${NODES} nodes`);
    assert.ok(moved > NODES * 0.9, `a 10k layout must move most nodes, ${moved} moved`);
  } finally {
    renderer.dispose();
  }
});
