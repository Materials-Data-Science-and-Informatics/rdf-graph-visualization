// Card D2 S3 — label LOD by zoom, headless.
//
// Labels are renderer display state (src/render/CONTRACT.md §2): the sigma
// adapter's nodeReducer keeps or drops each label from the camera zoom ratio
// and the node degree (high-degree tie-break). This test drives the REAL
// adapter on the fake DOM and checks two levels:
//
//   1. RENDERED labels — fake-dom records every canvas fillText, so we see
//      what sigma actually rasterised. Presence checks ride the adapter's
//      forceLabel path for high-degree nodes: sigma's own density/size
//      heuristics (labelRenderedSizeThreshold 6, default node size 2) would
//      otherwise cull small-node labels independent of the LOD. Absence
//      checks are absolute: a label the reducer dropped can never render.
//   2. The reducer DECISION for every node class, via getNodeLabelState() —
//      sigma's own cached display data, i.e. exactly what the renderer will
//      show for the current zoom.
//
// Zoom changes go through setCameraState() (the adapter's camera seam); the
// adapter's own camera listener is what re-derives labels — the test never
// touches sigma directly and never invalidates anything app-side.
//
// Run: npm run test

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeElement, fakeDom, fillTextLog, flushRaf } from "./fake-dom";
import type { FakeDomHandle } from "./fake-dom";
import {
  LABEL_HIGH_DEGREE_MIN,
  LABEL_HIGH_DEGREE_ZOOM_RATIO,
  LABEL_ZOOM_RATIO,
  createSigmaRenderer,
} from "../src/render/sigma";
import type { SigmaRenderer } from "../src/render/sigma";
import type { RendererGraph } from "../src/render/renderer";

const dom: FakeDomHandle = fakeDom;
const makeContainer = () => new FakeElement("DIV") as unknown as HTMLElement;

// A hub of degree 12 (clears the default high-degree bar of 10), 12 leaves
// (degree 1) and a 13-node directed ring (degree 2) — three label classes
// with distinct LOD behaviour under the DEFAULT options.
function makeLodGraph(): RendererGraph {
  const nodes: RendererGraph["nodes"] = [{ id: "hub", label: "HUB-ALPHA", group: "ClassA" }];
  const links: RendererGraph["links"] = [];
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: `leaf-${i}`, label: `Leaf ${i}`, group: "ClassB" });
    links.push({ source: "hub", target: `leaf-${i}` });
  }
  const RING = 13;
  for (let i = 0; i < RING; i++) {
    nodes.push({ id: `ring-${i}`, label: `Ring ${i}`, group: "ClassC" });
    links.push({ source: `ring-${i}`, target: `ring-${(i + 1) % RING}` });
  }
  return { nodes, links };
}

interface Observation {
  drawn: string[];
  hub: ReturnType<SigmaRenderer["getNodeLabelState"]>;
  ring: ReturnType<SigmaRenderer["getNodeLabelState"]>;
  leaf: ReturnType<SigmaRenderer["getNodeLabelState"]>;
}

/**
 * Set the camera zoom, pump sigma's own render loop, snapshot label
 * evidence. Only the ratio is touched: sigma auto-centres the camera on the
 * NORMALIZED graph (0.5, 0.5) at mount, and panning away would only make
 * sigma's on-screen culling of the label layer depend on seed positions.
 */
function observe(renderer: SigmaRenderer, ratio: number): Observation {
  fillTextLog.length = 0;
  renderer.setCameraState({ ratio });
  flushRaf();
  return {
    drawn: [...fillTextLog],
    hub: renderer.getNodeLabelState("hub"),
    ring: renderer.getNodeLabelState("ring-0"),
    leaf: renderer.getNodeLabelState("leaf-0"),
  };
}

test("D2-S3: defaults are the card's deterministic thresholds", () => {
  assert.equal(LABEL_ZOOM_RATIO, 2.5);
  assert.equal(LABEL_HIGH_DEGREE_ZOOM_RATIO, 5);
  assert.equal(LABEL_HIGH_DEGREE_MIN, 10);
});

test("D2-S3: labels hide at coarse zoom; high-degree nodes keep theirs", () => {
  const renderer = createSigmaRenderer(); // DEFAULT LOD options
  const container = makeContainer();
  renderer.mount(container);
  try {
    dom.reset();
    renderer.set(makeLodGraph());
    // Baseline off 1 so the first observe(1) is a real camera move (sigma
    // only emits camera "updated" on an actual state change; the mount-time
    // camera is already at ratio 1).
    renderer.setCameraState({ ratio: 1.5 });
    flushRaf();
    const positionsBefore = new Map(renderer.getPositions());

    // Regime "all labels" (ratio ≤ 2.5): every label is in the display data;
    // the hub renders (forceLabel), small nodes are left to sigma's own size
    // heuristic (they default below its render threshold — not our concern).
    const at1 = observe(renderer, 1);
    assert.deepEqual(at1.hub, { label: "HUB-ALPHA", forceLabel: true });
    assert.deepEqual(at1.ring, { label: "Ring 0", forceLabel: false });
    assert.equal(at1.leaf?.label, "Leaf 0");
    assert.deepEqual(at1.drawn, ["HUB-ALPHA"]);

    // Boundary is inclusive at 2.5 (deterministic, ≤).
    const atBoundary = observe(renderer, 2.5);
    assert.deepEqual(atBoundary.ring, { label: "Ring 0", forceLabel: false });

    // Regime "high-degree only" (2.5 < ratio ≤ 5): the hub KEEPS its label
    // (degree tie-break) and still renders; every ordinary label is gone —
    // from the display data AND from the canvas.
    const at3 = observe(renderer, 3);
    assert.deepEqual(at3.hub, { label: "HUB-ALPHA", forceLabel: true });
    assert.deepEqual(at3.ring, { label: null, forceLabel: false });
    assert.deepEqual(at3.leaf, { label: null, forceLabel: false });
    assert.deepEqual(at3.drawn, ["HUB-ALPHA"]);

    // Boundary inclusive at 5.
    assert.equal(observe(renderer, 5).hub?.label, "HUB-ALPHA");

    // Regime "none" (ratio > 5): even the hub loses its label; nothing is
    // rasterised at all.
    const at8 = observe(renderer, 8);
    assert.deepEqual(at8.hub, { label: null, forceLabel: false });
    assert.deepEqual(at8.drawn, []);

    // Zoom back in: the hub label comes back with NO app-side invalidation
    // — the adapter's camera listener forced the data pass.
    const backTo1 = observe(renderer, 1);
    assert.deepEqual(backTo1.hub, { label: "HUB-ALPHA", forceLabel: true });
    assert.deepEqual(backTo1.drawn, ["HUB-ALPHA"]);

    // Display-only rule: the whole LOD cycle never moved a single position.
    const positionsAfter = new Map(renderer.getPositions());
    assert.deepEqual([...positionsAfter], [...positionsBefore]);
  } finally {
    renderer.dispose();
  }
});

test("D2-S3: the LOD cycle is deterministic across repeated zoom sweeps", () => {
  const renderer = createSigmaRenderer();
  renderer.mount(makeContainer());
  try {
    dom.reset();
    renderer.set(makeLodGraph());
    renderer.setCameraState({ ratio: 1.5 }); // baseline, see above
    flushRaf();
    const cycle = (): Observation[] => [1, 3, 8, 1, 6, 2].map((ratio) => observe(renderer, ratio));
    const first = cycle();
    const second = cycle();
    assert.deepEqual(second, first, "same ratios → same label decisions and draws");
    // The cycle really flipped states (guards against a stuck observation).
    assert.deepEqual(first[1].drawn, first[3].drawn);
    assert.deepEqual(first[2].drawn, []);
    assert.notDeepEqual(first[0], first[2]);
  } finally {
    renderer.dispose();
  }
});

test("D2-S3: LOD thresholds are exposed through renderer options", () => {
  // (a) raising highDegreeMin removes the hub's exception (degree 12 < 20).
  const strict = createSigmaRenderer("sigma", { labelLod: { highDegreeMin: 20 } });
  strict.mount(makeContainer());
  strict.set(makeLodGraph());
  assert.equal(observe(strict, 3).hub?.label, null);
  strict.dispose();

  // (b) raising zoomRatio keeps ALL labels at ratio 3 (still regime "all").
  const generous = createSigmaRenderer("sigma", { labelLod: { zoomRatio: 10 } });
  generous.mount(makeContainer());
  generous.set(makeLodGraph());
  assert.equal(observe(generous, 3).ring?.label, "Ring 0");
  generous.dispose();

  // (c) the master switch keeps labels at any zoom (sigma heuristics only).
  const off = createSigmaRenderer("sigma", { labelLod: { enabled: false } });
  off.mount(makeContainer());
  off.set(makeLodGraph());
  const offState = observe(off, 999);
  assert.equal(offState.ring?.label, "Ring 0");
  assert.equal(offState.hub?.forceLabel, false); // no LOD-owned forcing
  off.dispose();

  // (d) a highDegreeZoomRatio below zoomRatio is floored at zoomRatio so the
  // regimes stay ordered (no hidden randomness in the clamp): with zoomRatio
  // 4 and highDegreeZoomRatio clamped up to 4, the hub keeps its label up to
  // ratio 4 but loses it beyond.
  const floored = createSigmaRenderer("sigma", {
    labelLod: { zoomRatio: 4, highDegreeZoomRatio: 2 },
  });
  floored.mount(makeContainer());
  floored.set(makeLodGraph());
  assert.equal(observe(floored, 4).hub?.label, "HUB-ALPHA"); // ≤ clamped high bound (4)
  assert.equal(observe(floored, 5).hub?.label, null); // > 4 → regime "none"
  floored.dispose();
});

test("D2-S3: camera/label seams honour the lifecycle rules", () => {
  const renderer = createSigmaRenderer();
  // Before mount: no camera, no label state; setCameraState throws (L2).
  assert.equal(renderer.getCameraState(), null);
  assert.equal(renderer.getNodeLabelState("hub"), null);
  assert.throws(() => renderer.setCameraState({ ratio: 1 }), /before mount/);

  renderer.mount(makeContainer());
  renderer.set(makeLodGraph());
  renderer.setCameraState({ x: 50, y: 50, ratio: 2 });
  assert.deepEqual(renderer.getCameraState(), { x: 50, y: 50, ratio: 2 });
  assert.equal(renderer.getNodeLabelState("no-such-node"), null);

  renderer.dispose();
  // After dispose: silent no-ops, null diagnostics (L3).
  assert.equal(renderer.getCameraState(), null);
  assert.equal(renderer.getNodeLabelState("hub"), null);
  assert.doesNotThrow(() => renderer.setCameraState({ ratio: 9 }));
});
