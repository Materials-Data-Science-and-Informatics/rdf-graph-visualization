// Card D1 — GraphRenderer positions/state contract test.
//
// Runs the full normative contract (src/render/CONTRACT.md) against one
// renderer factory. The reference run is the headless stub adapter
// (src/render/stub.ts); a real adapter (D2 sigma / D3 cosmos.gl) verifies
// itself by pointing `makeRenderer` below at its factory and providing a
// `activateNode` that simulates a user click (CONTRACT.md §7).
//
// Run: npm run test
// (scripts/run-contract-tests.mjs bundles this file with esbuild and runs it
// with Node's built-in test runner — no test-framework dependency.)

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { GraphStore } from "../src/store/graph-store";
import type { Edge, Node, SubgraphResponse } from "../src/api/types";
import type { GraphRenderer, RendererFactory, RendererGraph } from "../src/render";
import {
  createStubRenderer,
  createDefaultRenderer,
  createRenderer,
  defaultRendererId,
  registerRenderer,
  resetRendererRegistry,
  seedPosition,
  unregisterRenderer,
} from "../src/render";
import type { StubRenderer } from "../src/render";

// ---------------------------------------------------------------- harness

/**
 * The adapter under test. D2/D3: replace with
 * `() => createSigmaRenderer()` / `() => createCosmosRenderer()` and provide
 * a real `activateNode` (e.g. a synthetic pointer event at the node's
 * rendered position).
 */
const makeRenderer: RendererFactory = createStubRenderer;

/** Stub test hook: simulate a user activating a node (CONTRACT.md §7). */
const activateNode = (renderer: GraphRenderer, nodeId: string): void => {
  (renderer as StubRenderer).emitNodeSelect(nodeId);
};

/** The stub ignores the container; the type requires one. */
const CONTAINER = null as unknown as HTMLElement;

function makeNode(id: string, group = "person", label?: string): Node {
  return { id, label: label ?? `Label ${id}`, type: "Person", group };
}

function makeEdge(source: string, target: string, id?: string): Edge {
  return {
    id: id ?? `${source}->${target}`,
    source,
    target,
    predicate: "knows",
    label: "knows",
  };
}

function makeSlice(nodes: Node[], edges: Edge[], cursor?: string | null): SubgraphResponse {
  return { nodes, edges, page: { cursor, limit: 10, truncated: cursor != null } };
}

function newStoreWithTwoPages(): GraphStore {
  const store = new GraphStore();
  store.replaceSlice(makeSlice([makeNode("a"), makeNode("b")], [makeEdge("a", "b")], "p2"));
  return store;
}

function stubOf(renderer: GraphRenderer): StubRenderer {
  return renderer as StubRenderer;
}

// ---------------------------------------------------------------- §1 data

test("1.3 toGraphData() returns fresh object copies on every call", () => {
  const store = newStoreWithTwoPages();
  const first = store.toGraphData();
  const second = store.toGraphData();
  assert.notEqual(first, second);
  assert.equal(first.nodes.length, 2);
  for (let i = 0; i < first.nodes.length; i++) {
    assert.notEqual(first.nodes[i], second.nodes[i], `node ${i} must be a fresh copy`);
    assert.equal(first.nodes[i]?.id, second.nodes[i]?.id);
  }
  assert.notEqual(first.links[0], second.links[0], "link must be a fresh copy");
});

test("1.3 renderer-side mutation never leaks back into the store", () => {
  const store = newStoreWithTwoPages();
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);

  const handed = store.toGraphData();
  renderer.set(handed);
  // Simulate the engine claiming the objects (CONTRACT.md §1.2) and writing
  // positions into them.
  for (const node of handed.nodes) {
    node.x = 999;
    node.y = 999;
    node.z = 999;
  }

  const fresh = store.toGraphData();
  assert.equal(fresh.nodes[0]?.x, undefined, "store must not observe renderer positions");
  assert.equal(fresh.nodes[0]?.y, undefined);
  assert.equal(fresh.nodes[0]?.z, undefined);
  for (const node of fresh.nodes) {
    assert.notEqual(
      node,
      handed.nodes.find((n) => n.id === node.id)
    );
  }
  renderer.dispose();
});

test("1.4 toGraphData() output is directly assignable to RendererGraph", () => {
  const store = newStoreWithTwoPages();
  // The assertion below is compile-time (checked by `tsc -b`, CONTRACT.md
  // §1.4); the runtime checks keep it honest about shape.
  const data: RendererGraph = store.toGraphData();
  assert.equal(data.nodes.length, store.nodeCount);
  assert.equal(data.links.length, store.edgeCount);
  for (const node of data.nodes) assert.equal(typeof node.id, "string");
  for (const link of data.links) {
    assert.equal(typeof link.source, "string");
    assert.equal(typeof link.target, "string");
  }
});

// ---------------------------------------------------------------- §2 P*

test("P2 surviving nodes keep their exact positions across set()", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [] });
  const before = renderer.getPositions();

  // Expand-on-click shape: same nodes plus a new one (CONTRACT.md §2 P2).
  renderer.set({
    nodes: [makeNode("a"), makeNode("b"), makeNode("c")],
    links: [makeEdge("b", "c")],
  });
  const after = renderer.getPositions();

  assert.deepEqual(after.get("a"), before.get("a"), "survivor a must not move");
  assert.deepEqual(after.get("b"), before.get("b"), "survivor b must not move");
  assert.ok(after.has("c"), "new node must get a position");
  renderer.dispose();
});

test("P3 new nodes get defined, finite positions (no undefined/NaN)", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({
    nodes: [makeNode("a"), makeNode("b"), makeNode("c")],
    links: [makeEdge("a", "c")],
  });
  const positions = renderer.getPositions();
  assert.equal(positions.size, 3);
  for (const [id, pos] of positions) {
    assert.ok(Number.isFinite(pos.x), `${id}.x must be finite`);
    assert.ok(Number.isFinite(pos.y), `${id}.y must be finite`);
    if (pos.z !== undefined) assert.ok(Number.isFinite(pos.z), `${id}.z must be finite`);
  }
  renderer.dispose();
});

test("P3 seeding is deterministic: same id → same position, fresh instance", () => {
  const first = makeRenderer();
  first.mount(CONTAINER);
  first.set({ nodes: [makeNode("a")], links: [] });
  const fromFirst = first.getPositions().get("a");

  // A second, independent instance must reproduce the same point for "a"
  // (full reload should reproduce the layout, CONTRACT.md §2 P3).
  const second = makeRenderer();
  second.mount(CONTAINER);
  second.set({ nodes: [makeNode("a")], links: [] });
  const fromSecond = second.getPositions().get("a");

  assert.deepEqual(fromSecond, fromFirst, "same id must seed to the same point");
  assert.deepEqual(fromFirst, seedPosition("a"), "stub seeding = seedPosition(id)");
  first.dispose();
  second.dispose();
});

test("P4 removed nodes have all position state released", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [makeEdge("a", "b")] });
  renderer.set({ nodes: [makeNode("a")], links: [] });
  const positions = renderer.getPositions();
  assert.ok(positions.has("a"));
  assert.ok(!positions.has("b"), "ghost state for removed id must not survive");
  renderer.dispose();
});

test("P5 getPositions() is a full snapshot; caller mutation is harmless", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [] });

  const snapshot = renderer.getPositions();
  assert.deepEqual([...snapshot.keys()].sort(), ["a", "b"]);
  snapshot.delete("a");
  snapshot.set("ghost", { x: 1, y: 2 });

  const live = renderer.getPositions();
  assert.ok(live.has("a"), "snapshot mutation must not affect the renderer");
  assert.ok(!live.has("ghost"));
  renderer.dispose();
});

// ---------------------------------------------------------------- §3 V*

test("V2 focus applies on an increasing sequence", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [] });

  renderer.focus("a", 1);
  assert.deepEqual(stubOf(renderer).lastFocus, { nodeId: "a", sequence: 1 });
  renderer.focus("b", 2);
  assert.deepEqual(stubOf(renderer).lastFocus, { nodeId: "b", sequence: 2 });
  renderer.dispose();
});

test("V2 stale (non-increasing) focus tokens are ignored", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [] });

  renderer.focus("a", 5);
  renderer.focus("b", 5); // duplicate: must be ignored
  renderer.focus("b", 4); // older: must be ignored
  assert.deepEqual(stubOf(renderer).lastFocus, { nodeId: "a", sequence: 5 });
  renderer.dispose();
});

test("V2 unknown node ids are no-ops and do not consume the token", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });

  renderer.focus("never-delivered", 99); // no-op, NOT an error
  assert.equal(stubOf(renderer).lastFocus, null);
  renderer.focus("a", 99); // the token must still be available
  assert.deepEqual(stubOf(renderer).lastFocus, { nodeId: "a", sequence: 99 });
  renderer.dispose();
});

test("V2 focus token survives store reload and re-triggers the renderer", () => {
  const store = new GraphStore();
  store.replaceSlice(makeSlice([makeNode("a"), makeNode("b")], [makeEdge("a", "b")], "p2"));

  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set(store.toGraphData());

  store.focus("a");
  const seq1 = store.focusSequence;
  assert.equal(seq1, 1);
  renderer.focus("a", seq1);
  assert.deepEqual(stubOf(renderer).lastFocus, { nodeId: "a", sequence: seq1 });

  // A fresh load (new store generation) must NOT reset the token: the
  // mounted renderer outlives a single load and gates on monotonicity.
  store.replaceSlice(makeSlice([makeNode("a"), makeNode("c")], [makeEdge("a", "c")]));
  assert.equal(store.focusSequence, seq1, "focusSequence must not reset on replaceSlice");
  renderer.set(store.toGraphData());

  store.focus("a"); // same node again → sequence bumps
  const seq2 = store.focusSequence;
  assert.ok(seq2 > seq1, "sequence must keep increasing");
  renderer.focus("a", seq2);
  assert.deepEqual(stubOf(renderer).lastFocus, { nodeId: "a", sequence: seq2 });
  renderer.dispose();
});

// ---------------------------------------------------------------- §4 S*

test("S1 onNodeSelect delivers the node id; unsubscribe stops delivery", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });

  const seen: string[] = [];
  const seen2: string[] = [];
  renderer.onNodeSelect((id) => seen.push(id));
  const unsubscribe = renderer.onNodeSelect((id) => seen2.push(id));

  activateNode(renderer, "a");
  assert.deepEqual(seen, ["a"]);
  assert.deepEqual(seen2, ["a"]);
  assert.equal(typeof seen[0], "string", "renderer reports the id only (S1)");

  unsubscribe();
  activateNode(renderer, "a");
  assert.deepEqual(seen, ["a", "a"]);
  assert.deepEqual(seen2, ["a"], "unsubscribed callback must not fire");
  renderer.dispose();
});

test("S1/L3 no onNodeSelect callbacks are delivered after dispose()", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });
  const seen: string[] = [];
  renderer.onNodeSelect((id) => seen.push(id));

  renderer.dispose();
  activateNode(renderer, "a");
  assert.deepEqual(seen, [], "no callbacks after dispose");
});

// ---------------------------------------------------------------- §5 L*

test("L1 mount() exactly once: a second mount throws", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  assert.throws(() => renderer.mount(CONTAINER), /mount/i);
  renderer.dispose();
});

test("L2 set/focus/resize/resetView before mount throw", () => {
  const renderer = makeRenderer();
  const graph: RendererGraph = { nodes: [makeNode("a")], links: [] };
  assert.throws(() => renderer.set(graph), /before mount/i);
  assert.throws(() => renderer.focus("a", 1), /before mount/i);
  assert.throws(() => renderer.resize(100, 100), /before mount/i);
  assert.throws(() => renderer.resetView(), /before mount/i);
});

test("L3 after dispose() every method is a silent no-op", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });
  renderer.dispose();

  const graph: RendererGraph = { nodes: [makeNode("a")], links: [] };
  assert.doesNotThrow(() => renderer.mount(CONTAINER));
  assert.doesNotThrow(() => renderer.set(graph));
  assert.doesNotThrow(() => renderer.focus("a", 1));
  assert.doesNotThrow(() => renderer.resize(1, 2));
  assert.doesNotThrow(() => renderer.resetView());
  assert.equal(renderer.getPositions().size, 0, "state released on dispose");
});

test("L4 dispose() is idempotent", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });
  assert.doesNotThrow(() => {
    renderer.dispose();
    renderer.dispose();
  });
});

// ---------------------------------------------------------------- §6 R*

beforeEach(() => resetRendererRegistry());

test("R1 register rejects empty ids, duplicate ids, and non-function factories", () => {
  assert.throws(() => registerRenderer("", makeRenderer), /non-empty/i);
  assert.throws(() => registerRenderer("   ", makeRenderer), /non-empty/i);
  registerRenderer("stub", makeRenderer);
  assert.throws(() => registerRenderer("stub", makeRenderer), /already registered/i);
  assert.throws(
    () => registerRenderer("bad", 42 as unknown as RendererFactory),
    /must be a function/i
  );
});

test("R2 createRenderer returns fresh, independent instances", () => {
  registerRenderer("stub", makeRenderer);
  const r1 = createRenderer("stub");
  const r2 = createRenderer("stub");
  assert.notEqual(r1, r2);
  assert.equal(r1.id, "stub");
  assert.equal(r2.id, "stub");
  r1.mount(CONTAINER);
  // r2 is a different instance: mounting it must not be affected by r1.
  assert.doesNotThrow(() => r2.mount(CONTAINER));
  r1.dispose();
  r2.dispose();
});

test("R3 default: first registered wins; isDefault opts in; later never steal", () => {
  registerRenderer("a", makeRenderer);
  assert.equal(defaultRendererId(), "a");
  registerRenderer("b", makeRenderer);
  assert.equal(defaultRendererId(), "a", "later registration must not steal the default");
  registerRenderer("c", makeRenderer, { isDefault: true });
  assert.equal(defaultRendererId(), "c");
});

test("R3 unregistering the default falls back to the first remaining id, then null", () => {
  registerRenderer("a", makeRenderer);
  registerRenderer("b", makeRenderer);
  registerRenderer("c", makeRenderer, { isDefault: true });
  assert.equal(unregisterRenderer("c"), true);
  assert.equal(defaultRendererId(), "a", "falls back to first remaining (insertion order)");
  assert.equal(unregisterRenderer("a"), true);
  assert.equal(defaultRendererId(), "b");
  assert.equal(unregisterRenderer("b"), true);
  assert.equal(defaultRendererId(), null);
  assert.equal(unregisterRenderer("unknown"), false);
});

test("R4 unknown create and empty default throw with useful messages", () => {
  registerRenderer("stub", makeRenderer);
  assert.throws(
    () => createRenderer("nope"),
    (err: Error) => {
      assert.match(err.message, /nope/);
      assert.match(err.message, /stub/, "message lists what IS available");
      return true;
    }
  );
  resetRendererRegistry();
  assert.throws(() => createDefaultRenderer(), /no renderers/i);
});

test("factory returning an instance whose id mismatches the registry key throws", () => {
  registerRenderer("x", () => createStubRenderer("y"));
  assert.throws(() => createRenderer("x"), /id/i);
});
