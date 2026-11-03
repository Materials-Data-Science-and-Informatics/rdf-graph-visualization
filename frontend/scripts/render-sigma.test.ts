// Card D2 — sigma adapter contract test + 2k-node fixture check.
//
// Runs the full normative contract (src/render/CONTRACT.md) against the REAL
// sigma adapter (src/render/sigma.ts) in Node, using the fake DOM
// (fake-dom.ts): sigma's real JS-side scene construction, camera, picking,
// and event pipeline run end-to-end; only the rasterisation sinks (2D canvas
// / WebGL) are no-ops that record their calls.
//
// "Simulating a user click" (CONTRACT.md §7 activateNode): sigma hit-tests
// through its picking layer, which decodes the item index from the pixel RGB
// it read back (index = b + (g<<8) + (r<<16), item index starts at 1 in
// graph order). The fake readPixels is armed with that encoding for the
// target node, and a real "click" DOM event is dispatched on sigma's mouse
// canvas — the captor → pick → clickNode → onNodeSelect path is the real one.
// The contract suite's activation test always sets exactly one node, so its
// picking index is 1.
//
// Run: npm run test

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeElement, fakeDom, flushRaf, glCounts } from "./fake-dom";
import type { FakeDomHandle } from "./fake-dom";
import { makeTwoThousandNodeGraph } from "./fixtures/cosmos-two-thousand";
import {
  createDefaultRenderer,
  createSigmaRenderer,
  defaultRendererId,
  registerEngines,
  resetRendererRegistry,
} from "../src/render";

const dom: FakeDomHandle = fakeDom;

const makeContainer = () => new FakeElement("DIV") as unknown as HTMLElement;

const activateNode = (
  _renderer: import("../src/render").GraphRenderer,
  _nodeId: string,
  container: HTMLElement
): void => {
  const fakeContainer = container as unknown as FakeElement;
  dom.armPickingIndex(1); // single-node suite graph → item index 1
  try {
    // The captor binds to elements.mouse (the touchAction:none canvas); the
    // fake DOM has no bubbling, so the click must land on that canvas.
    // After dispose() sigma has killed its DOM — no canvas, no delivery path.
    const canvas = fakeContainer.children.find(
      (c): c is FakeElement => c.tagName === "CANVAS" && c.style.touchAction === "none"
    );
    if (canvas) dom.dispatchClick(canvas, 1, 1);
  } finally {
    dom.clearArmedPixel();
  }
};

runContractSuiteFromLocal();

// The suite import must not hoist-install anything; call it explicitly so
// the fake DOM is in place first (module import order safety).
import { runContractSuite } from "./render-contract-suite";

function runContractSuiteFromLocal(): void {
  runContractSuite({
    adapterId: "sigma",
    makeRenderer: () => createSigmaRenderer(),
    makeContainer,
    activateNode,
    flush: () => flushRaf(),
  });
}

// ------------------------------------------------------------------ D2 S1

// The shared deterministic 2k fixture (card D3 S1): a connected ring plus
// cross-links over five groups (every 17th node ungrouped) — the same graph
// every adapter card renders, so results are comparable.
test("D2-S1: sigma renders the 2k-node fixture through the GraphRenderer contract", () => {
  const { nodes, links } = makeTwoThousandNodeGraph();
  const NODES = nodes.length;
  assert.equal(NODES, 2000);
  const container = makeContainer();
  const renderer = createSigmaRenderer();
  renderer.mount(container);
  try {
    dom.reset();
    const t0 = performance.now();
    renderer.set({ nodes, links });
    const setMs = performance.now() - t0;
    flushRaf(); // let sigma's scheduled render run (scene + picking table)

    // P5/P6: a full position snapshot for every node, 2D and finite.
    const positions = renderer.getPositions();
    assert.equal(positions.size, NODES);
    for (const [id, pos] of positions) {
      assert.ok(Number.isFinite(pos.x), `${id}.x must be finite`);
      assert.ok(Number.isFinite(pos.y), `${id}.y must be finite`);
      assert.equal(pos.z, undefined, "2D adapter must not emit z (P6)");
    }

    // Scene evidence: sigma's programs received geometry (WebGL draw calls
    // happened) — the 2k fixture actually went through the renderer.
    assert.ok(glCounts.drawCalls > 0, "sigma must have issued draw calls");
    assert.ok(glCounts.bufferData > 0, "sigma must have uploaded geometry");

    // P2 at scale: ingesting an expansion page must not move survivors.
    const before = renderer.getPositions();
    renderer.set({
      nodes: [...nodes, { id: "node-new", label: "New", group: "ClassA" }],
      links: [...links, { id: "e-new", source: "node-1999", target: "node-new" }],
    });
    const after = renderer.getPositions();
    assert.equal(after.size, NODES + 1);
    for (const [id, pos] of before) {
      assert.deepEqual(after.get(id), pos, `survivor ${id} must not move`);
    }

    // Selection at scale: pick a deep node (item index 1501 in graph order).
    const seen: string[] = [];
    renderer.onNodeSelect((id) => seen.push(id));
    flushRaf(); // render the post-expansion scene so its picking table is fresh
    dom.armPickingIndex(1501);
    try {
      const canvas = (container as unknown as FakeElement).children.find(
        (c): c is FakeElement => c.tagName === "CANVAS" && c.style.touchAction === "none"
      );
      if (!canvas) throw new Error("sigma must have its mouse canvas to receive the click");
      dom.dispatchClick(canvas, 1, 1);
    } finally {
      dom.clearArmedPixel();
    }
    assert.deepEqual(seen, ["node-1500"], "picking must decode the 1501st node");

    // V2 at scale: focus gate works with the 2k scene mounted.
    renderer.focus("node-42", 1);
    renderer.focus("node-42", 1); // stale: ignored
    assert.deepEqual(
      (renderer as { lastFocus: { nodeId: string; sequence: number } | null }).lastFocus,
      {
        nodeId: "node-42",
        sequence: 1,
      }
    );

    // V3 at scale: fit-all over the 2k bounding box (no throw, no NaN).
    assert.doesNotThrow(() => {
      renderer.resetView();
      flushRaf();
    });

    // Incremental growth (cursor pages) at 2k stays comfortably fast.
    assert.ok(setMs < 30_000, `set(2k) took ${setMs.toFixed(0)}ms — suspiciously slow`);
    console.log(
      `  [D2-S1] 2k set(): ${setMs.toFixed(1)}ms, ` +
        `drawCalls=${glCounts.drawCalls}, bufferData=${glCounts.bufferData}`
    );
  } finally {
    renderer.dispose();
  }
});

test("D2-S1: registry — registerEngines() makes sigma the default renderer", () => {
  resetRendererRegistry();
  assert.equal(defaultRendererId(), null);
  registerEngines();
  registerEngines(); // idempotent
  assert.equal(defaultRendererId(), "sigma");
  const renderer = createDefaultRenderer();
  assert.equal(renderer.id, "sigma");
  assert.equal(renderer.mount(makeContainer()), undefined);
  renderer.set({ nodes: [{ id: "a", label: "a", group: "Document" }], links: [] });
  assert.equal(renderer.getPositions().size, 1);
  renderer.dispose();
});
