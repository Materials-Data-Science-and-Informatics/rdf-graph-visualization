// Card D3 — GraphRenderer positions/state contract test for the cosmos.gl
// adapter (src/render/cosmos.ts).
//
// Runs the same normative contract (src/render/CONTRACT.md) the D1 stub suite
// (render-contract.test.ts) verifies, but against `createCosmosRenderer`.
// The adapter is exercised in its **headless** (state-only) mode: `mount` is
// handed a null container, so no WebGL engine is constructed and every
// contract method operates on the adapter's authoritative position map. This
// is what lets the full positions/state contract run under Node (CONTRACT.md
// §7 — "point the test's makeRenderer at it and provide an activateNode").
//
// Imports go straight to the leaf modules (./cosmos, ./registry, ./renderer)
// rather than through src/render/index.ts, so this suite is independent of the
// other adapters' wiring in that barrel.
//
// Run: node scripts/run-cosmos-tests.mjs  (esbuild-bundled, Node test runner)

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { GraphStore } from "../src/store/graph-store";
import type { Edge, Node, SubgraphResponse } from "../src/api/types";
import type {
  GraphRenderer,
  NodePosition,
  RendererFactory,
  RendererGraph,
} from "../src/render/renderer";
import { createCosmosRenderer } from "../src/render/cosmos";
import type { CosmosRenderer } from "../src/render/cosmos";
import {
  createRenderer,
  registerRenderer,
  resetRendererRegistry,
  unregisterRenderer,
  defaultRendererId,
} from "../src/render/registry";

// ---------------------------------------------------------------- harness

/** The adapter under test. */
const makeRenderer: RendererFactory = () => createCosmosRenderer();

/** Simulate a user activating a node (the adapter's host-activation hook). */
const activateNode = (renderer: GraphRenderer, nodeId: string): void => {
  (renderer as CosmosRenderer).emitNodeSelect(nodeId);
};

/** The headless test environment hands mount() a null container. */
const CONTAINER = null as unknown as HTMLElement;

function cosmosOf(renderer: GraphRenderer): CosmosRenderer {
  return renderer as CosmosRenderer;
}

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
  for (const node of handed.nodes) {
    node.x = 999;
    node.y = 999;
    node.z = 999;
  }

  const fresh = store.toGraphData();
  assert.equal(fresh.nodes[0]?.x, undefined, "store must not observe renderer positions");
  assert.equal(fresh.nodes[0]?.y, undefined);
  assert.equal(fresh.nodes[0]?.z, undefined);
  renderer.dispose();
});

test("1.4 toGraphData() output is directly assignable to RendererGraph", () => {
  const store = newStoreWithTwoPages();
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
  for (const [nodeId, pos] of positions) {
    assert.ok(Number.isFinite(pos.x), `${nodeId}.x must be finite`);
    assert.ok(Number.isFinite(pos.y), `${nodeId}.y must be finite`);
    if (pos.z !== undefined) assert.ok(Number.isFinite(pos.z), `${nodeId}.z must be finite`);
  }
  renderer.dispose();
});

test("P3 seeding is deterministic: same id -> same point, fresh instance", () => {
  const first = makeRenderer();
  first.mount(CONTAINER);
  first.set({ nodes: [makeNode("a")], links: [] });
  const fromFirst = first.getPositions().get("a");

  const second = makeRenderer();
  second.mount(CONTAINER);
  second.set({ nodes: [makeNode("a")], links: [] });
  const fromSecond = second.getPositions().get("a");

  assert.deepEqual(fromSecond, fromFirst, "same id must seed to the same point");
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

  const snapshot = renderer.getPositions() as unknown as Map<string, NodePosition>;
  // P5: the returned snapshot is a standalone copy — mutating it must not
  // affect the renderer (the type is ReadonlyMap to signal "don't rely on it").
  assert.deepEqual([...snapshot.keys()].sort(), ["a", "b"]);
  snapshot.delete("a");
  snapshot.set("ghost", { x: 1, y: 2 });

  const live = renderer.getPositions();
  assert.ok(live.has("a"), "snapshot mutation must not affect the renderer");
  assert.ok(!live.has("ghost"));
  renderer.dispose();
});

test("P6 a 2D adapter omits z in NodePosition", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });
  const pos = renderer.getPositions().get("a");
  assert.ok(pos, "position present");
  assert.equal(pos?.z, undefined, "2D adapter must omit z");
  renderer.dispose();
});

// ---------------------------------------------------------------- §3 V*

test("V2 focus applies on an increasing sequence", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [] });

  renderer.focus("a", 1);
  assert.deepEqual(cosmosOf(renderer).lastFocus, { nodeId: "a", sequence: 1 });
  renderer.focus("b", 2);
  assert.deepEqual(cosmosOf(renderer).lastFocus, { nodeId: "b", sequence: 2 });
  renderer.dispose();
});

test("V2 stale (non-increasing) focus tokens are ignored", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [] });

  renderer.focus("a", 5);
  renderer.focus("b", 5); // duplicate: must be ignored
  renderer.focus("b", 4); // older: must be ignored
  assert.deepEqual(cosmosOf(renderer).lastFocus, { nodeId: "a", sequence: 5 });
  renderer.dispose();
});

test("V2 unknown node ids are no-ops and do not consume the token", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });

  renderer.focus("never-delivered", 99); // no-op, NOT an error
  assert.equal(cosmosOf(renderer).lastFocus, null);
  renderer.focus("a", 99); // the token must still be available
  assert.deepEqual(cosmosOf(renderer).lastFocus, { nodeId: "a", sequence: 99 });
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
  assert.deepEqual(cosmosOf(renderer).lastFocus, { nodeId: "a", sequence: seq1 });

  store.replaceSlice(makeSlice([makeNode("a"), makeNode("c")], [makeEdge("a", "c")]));
  assert.equal(store.focusSequence, seq1, "focusSequence must not reset on replaceSlice");
  renderer.set(store.toGraphData());

  store.focus("a"); // same node again -> sequence bumps
  const seq2 = store.focusSequence;
  assert.ok(seq2 > seq1, "sequence must keep increasing");
  renderer.focus("a", seq2);
  assert.deepEqual(cosmosOf(renderer).lastFocus, { nodeId: "a", sequence: seq2 });
  renderer.dispose();
});

// ---------------------------------------------------------------- §4 S*

test("S1 onNodeSelect delivers the node id; unsubscribe stops delivery", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a")], links: [] });

  const seen: string[] = [];
  const seen2: string[] = [];
  renderer.onNodeSelect((nodeId) => seen.push(nodeId));
  const unsubscribe = renderer.onNodeSelect((nodeId) => seen2.push(nodeId));

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
  renderer.onNodeSelect((nodeId) => seen.push(nodeId));

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

// ---------------------------------------------------------------- D3 mode

test("D3 null container mounts headless (state-only, no GL engine)", () => {
  const renderer = makeRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [makeNode("a"), makeNode("b")], links: [makeEdge("a", "b")] });
  assert.equal(cosmosOf(renderer).headless, true, "null container -> headless");
  assert.equal(renderer.getPositions().size, 2, "positions still held headlessly");
  assert.equal(cosmosOf(renderer).setCount, 1);
  renderer.dispose();
});

// ---------------------------------------------------------------- §6 R*

beforeEach(() => resetRendererRegistry());

test("R1 register rejects empty ids, duplicate ids, non-function factories", () => {
  assert.throws(() => registerRenderer("", makeRenderer), /non-empty/i);
  assert.throws(() => registerRenderer("   ", makeRenderer), /non-empty/i);
  registerRenderer("cosmos", makeRenderer);
  assert.throws(() => registerRenderer("cosmos", makeRenderer), /already registered/i);
  assert.throws(
    () => registerRenderer("bad", 42 as unknown as RendererFactory),
    /must be a function/i
  );
});

test("R2 createRenderer returns fresh, independent instances", () => {
  registerRenderer("cosmos", makeRenderer);
  const r1 = createRenderer("cosmos");
  const r2 = createRenderer("cosmos");
  assert.notEqual(r1, r2);
  assert.equal(r1.id, "cosmos");
  assert.equal(r2.id, "cosmos");
  r1.mount(CONTAINER);
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

test("factory returning an instance whose id mismatches the registry key throws", () => {
  registerRenderer("x", () => createCosmosRenderer("y"));
  assert.throws(() => createRenderer("x"), /id/i);
});
