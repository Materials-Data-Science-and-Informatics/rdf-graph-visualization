// cosmos3d adapter — headless contract suite (state-only mode).
//
// The 3D adapter deviates from the 2D position-memory contract ON PURPOSE
// (live GPU simulation, see cosmos3d.ts header). This suite pins what MUST
// hold regardless of the simulation: the lifecycle guards, 3D positions on
// getPositions(), start/stopLayout mapping to the simulation flag, the
// focus token gate (V2) and idempotent dispose. All under Node: a non-DOM
// container keeps the adapter in state-only mode (no WebGL needed).
//
// Run: pnpm test (esbuild-bundled by run-contract-tests.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RendererGraph } from "../src/render";
import { createCosmos3dRenderer, COSMOS3D_RENDERER_ID } from "../src/render/cosmos3d";

const GRAPH: RendererGraph = {
  nodes: [
    { id: "a", label: "A", group: "Dataset" },
    { id: "b", label: "B", group: "Person" },
    { id: "c", label: "C" },
  ],
  links: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
};

function mountedHeadless() {
  const renderer = createCosmos3dRenderer(COSMOS3D_RENDERER_ID);
  renderer.mount(null as unknown as HTMLElement); // non-DOM → state-only
  return renderer;
}

test("cosmos3d: lifecycle — guards, idempotent dispose (contract §5)", () => {
  const renderer = createCosmos3dRenderer(COSMOS3D_RENDERER_ID);
  assert.equal(renderer.mounted, false);
  assert.throws(() => renderer.set(GRAPH), /before mount/);
  renderer.mount(null as unknown as HTMLElement);
  assert.equal(renderer.headless, true);
  renderer.set(GRAPH);
  renderer.dispose();
  renderer.dispose(); // L4: idempotent
  assert.equal(renderer.disposed, true);
  renderer.set(GRAPH); // post-dispose: silent no-op
  assert.equal(renderer.setCount, 1);
});

test("cosmos3d: getPositions fills z for every node (3D contract)", () => {
  const renderer = mountedHeadless();
  renderer.set(GRAPH);
  const pos = renderer.getPositions();
  assert.equal(pos.size, 3);
  for (const id of ["a", "b", "c"]) {
    const p = pos.get(id);
    assert.ok(p, `position for ${id}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
  renderer.dispose();
});

test("cosmos3d: survivors keep positions; new ids seed; removed ids drop (P2-P4)", () => {
  const renderer = mountedHeadless();
  renderer.set(GRAPH);
  const before = renderer.getPositions();
  renderer.set({
    nodes: [
      { id: "a", label: "A", group: "Dataset" },
      { id: "b", label: "B", group: "Person" },
      { id: "d", label: "D" },
    ],
    links: [{ source: "a", target: "b" }],
  });
  const after = renderer.getPositions();
  assert.deepEqual(
    { a: after.get("a"), b: after.get("b") },
    { a: before.get("a"), b: before.get("b") }
  );
  assert.equal(after.has("c"), false);
  assert.ok(after.get("d"));
  renderer.dispose();
});

test("cosmos3d: handed xyz from a switch handoff is adopted (P7)", () => {
  const renderer = mountedHeadless();
  renderer.set({ nodes: [{ id: "h", x: 1, y: 2, z: 3 }], links: [] });
  assert.deepEqual(renderer.getPositions().get("h"), { x: 1, y: 2, z: 3 });
  renderer.dispose();
});

test("cosmos3d: start/stopLayout toggle the simulation flag", () => {
  const renderer = mountedHeadless();
  renderer.set(GRAPH);
  assert.equal(renderer.simulating, true); // live sim is the default look
  renderer.stopLayout();
  assert.equal(renderer.simulating, false);
  assert.equal(renderer.layoutRunning, false);
  renderer.startLayout();
  assert.equal(renderer.simulating, true);
  renderer.dispose();
});

test("cosmos3d: focus gate — unknown ids and stale tokens never consume (V2)", () => {
  const renderer = mountedHeadless();
  renderer.set(GRAPH);
  renderer.focus("nope", 5);
  assert.equal(renderer.lastFocus, null);
  renderer.focus("a", 7);
  assert.deepEqual(renderer.lastFocus, { nodeId: "a", sequence: 7 });
  renderer.focus("b", 7); // stale (<= last applied)
  assert.deepEqual(renderer.lastFocus, { nodeId: "a", sequence: 7 });
  renderer.focus("b", 8);
  assert.deepEqual(renderer.lastFocus, { nodeId: "b", sequence: 8 });
  renderer.dispose();
});

test("cosmos3d: node activation fires listeners (contract §4)", () => {
  const renderer = mountedHeadless();
  renderer.set(GRAPH);
  const seen: string[] = [];
  const off = renderer.onNodeSelect((nodeId) => seen.push(nodeId));
  renderer.emitNodeSelect("b");
  off();
  renderer.emitNodeSelect("c");
  assert.deepEqual(seen, ["b"]);
  renderer.dispose();
});
