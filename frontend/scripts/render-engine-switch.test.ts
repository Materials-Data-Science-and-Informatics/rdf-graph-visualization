// Card D4 — renderer switch (engine toggle) tests.
//
// The DoD under test: an engine switch is a no-refetch / no-relayout /
// no-lost-selection operation. In Node that translates to:
//
//   1. withCarriedPositions(): the P5 → P7 handoff prepares the incoming
//      renderer's data from the outgoing renderer's getPositions() snapshot
//      (deep copies, finite values only, no input mutation);
//   2. every adapter adopts handed finite x/y on NEW nodes (P7): stub,
//      sigma (fake DOM), cosmos (headless) — non-finite values fall back to
//      the deterministic seed;
//   3. a full real-adapter switch (sigma → cosmos → sigma) carries every
//      position verbatim, starts no layout run, and the focus token replays
//      on each incoming renderer; the store is never touched.
//
// Run: npm run test

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeElement, flushRaf } from "./fake-dom";
import { makeTwoThousandNodeGraph } from "./fixtures/cosmos-two-thousand";
import { adoptedCoordinate } from "../src/render/renderer";
import type { NodePosition, RendererGraph } from "../src/render/renderer";
import { createStubRenderer, seedPosition } from "../src/render/stub";
import { seedPosition2D } from "../src/render/seeding";
import { createSigmaRenderer, SIGMA_RENDERER_ID } from "../src/render/sigma";
import type { SigmaRenderer } from "../src/render/sigma";
import { createCosmosRenderer, COSMOS_RENDERER_ID } from "../src/render/cosmos";
import type { CosmosRenderer } from "../src/render/cosmos";
import {
  createRenderer,
  defaultRendererId,
  listRenderers,
  registerEngines,
  resetRendererRegistry,
  snapshotGraph,
  withCarriedPositions,
} from "../src/render";
import { parseViewState, toSearch, DEFAULT_VIEW_STATE } from "../src/view-state";

const makeContainer = () => new FakeElement("DIV") as unknown as HTMLElement;
const HEADLESS = null as unknown as HTMLElement;

// ---------------------------------------------------------------- helpers

function smallGraph(count = 12): RendererGraph {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    label: `Label ${i}`,
    group: i % 5 === 0 ? "" : "ClassA",
    color: undefined,
  }));
  const links = Array.from({ length: count - 1 }, (_, i) => ({
    id: `e${i}`,
    source: `n${i}`,
    target: `n${i + 1}`,
    label: "knows",
  }));
  return { nodes, links };
}

function deepPositions(r: {
  getPositions(): ReadonlyMap<string, NodePosition>;
}): Map<string, NodePosition> {
  const out = new Map<string, NodePosition>();
  for (const [id, pos] of r.getPositions()) out.set(id, { ...pos });
  return out;
}

// ------------------------------------------------- P7: adoptedCoordinate

test("D4: adoptedCoordinate accepts finite numbers, rejects undefined/NaN/Infinity", () => {
  assert.equal(adoptedCoordinate(0), 0);
  assert.equal(adoptedCoordinate(-1.5), -1.5);
  assert.equal(adoptedCoordinate(Infinity), undefined);
  assert.equal(adoptedCoordinate(-Infinity), undefined);
  assert.equal(adoptedCoordinate(Number.NaN), undefined);
  assert.equal(adoptedCoordinate(undefined), undefined);
});

// ------------------------------------------------- P7: adapters adopt

test("D4/P7: the stub adopts handed finite x/y/z on new nodes", () => {
  const r = createStubRenderer();
  r.mount(HEADLESS);
  r.set({
    nodes: [
      { id: "a", x: 11.5, y: 22.5, z: 33.5 },
      { id: "b" }, // no coordinates → deterministic seed
    ],
    links: [],
  });
  const pos = r.getPositions();
  assert.deepEqual(pos.get("a"), { x: 11.5, y: 22.5, z: 33.5 }, "handed coordinates adopted");
  assert.deepEqual(pos.get("b"), seedPosition("b"), "unhanded node keeps the deterministic seed");
  r.dispose();
});

test("D4/P7: the sigma adapter adopts handed finite x/y on new nodes (2D: z ignored)", () => {
  const r = createSigmaRenderer();
  r.mount(makeContainer());
  r.set({
    nodes: [
      { id: "a", x: 11.5, y: 22.5, z: 33.5 },
      { id: "b", x: Number.NaN }, // non-finite → seed fallback
    ],
    links: [],
  });
  const pos = r.getPositions();
  assert.deepEqual(pos.get("a"), { x: 11.5, y: 22.5 }, "handed 2D coordinates adopted, z dropped");
  const seedB = seedPosition2D("b");
  assert.deepEqual(pos.get("b"), { x: seedB.x, y: seedB.y }, "non-finite x falls back to the seed");
  r.dispose();
});

test("D4/P7: the cosmos adapter adopts handed finite x/y on new nodes", () => {
  const r = createCosmosRenderer();
  r.mount(HEADLESS);
  r.set({
    nodes: [{ id: "a", x: 41.25, y: 42.75 }, { id: "b" }],
    links: [],
  });
  const pos = r.getPositions();
  assert.deepEqual(pos.get("a"), { x: 41.25, y: 42.75 }, "handed coordinates adopted");
  assert.ok(Number.isFinite(pos.get("b")?.x ?? NaN), "unhanded node seeded");
  r.dispose();
});

// --------------------------------------------- P5: withCarriedPositions

test("D4/P5: withCarriedPositions deep-copies, fills carried positions, never mutates input", () => {
  const graph = smallGraph();
  const positions = new Map<string, NodePosition>([
    ["n0", { x: 1, y: 2 }],
    ["n1", { x: Number.NaN, y: 3 }], // corrupted entry: x must NOT be written
    ["n2", { x: 4, y: 5, z: 6 }],
  ]);
  const originalNodes = graph.nodes.map((n) => ({ ...n }));
  const originalLinks = graph.links.map((l) => ({ ...l }));

  const out = withCarriedPositions(graph, positions);

  // Fresh objects: mutating the output must not touch the input (1.2).
  assert.notEqual(out, graph);
  assert.notEqual(out.nodes[0], graph.nodes[0]);
  assert.notEqual(out.links[0], graph.links[0]);
  // Carried values landed (finite only).
  assert.equal(out.nodes[0]?.x, 1);
  assert.equal(out.nodes[0]?.y, 2);
  assert.equal(out.nodes[1]?.x, undefined, "non-finite carried x must not be written");
  assert.equal(out.nodes[1]?.y, 3);
  assert.deepEqual(
    { x: out.nodes[2]?.x, y: out.nodes[2]?.y, z: out.nodes[2]?.z },
    { x: 4, y: 5, z: 6 }
  );
  // Nodes without a carried entry are copied as-is (no coordinates).
  assert.equal(out.nodes[3]?.x, undefined);
  // Every other field survives the copy.
  assert.equal(out.nodes[0]?.label, "Label 0");
  assert.equal(out.nodes[0]?.group, ""); // n0 is ungrouped in smallGraph
  assert.equal(out.nodes[1]?.group, "ClassA");
  assert.equal(out.links[0]?.source, "n0");
  assert.equal(out.links[0]?.label, "knows");
  // NOW mutate the output: the input must stay untouched.
  out.nodes[0]!.x = 999;
  assert.equal(graph.nodes[0]?.x, undefined, "input graph untouched");
  assert.deepEqual(graph.nodes, originalNodes, "input nodes untouched");
  assert.deepEqual(graph.links, originalLinks, "input links untouched");
});

test("D4/P5: snapshotGraph deep-copies nodes and links", () => {
  const graph = smallGraph();
  const out = snapshotGraph(graph);
  assert.notEqual(out, graph);
  assert.notEqual(out.nodes[0], graph.nodes[0]);
  assert.notEqual(out.links[0], graph.links[0]);
  assert.deepEqual(out.nodes[0], graph.nodes[0]);
  assert.deepEqual(out.links[0], graph.links[0]);
});

// ------------------------------------------- registry: both engines in

test("D4/R3: registerEngines() registers sigma (default) AND cosmos (non-default)", () => {
  resetRendererRegistry();
  registerEngines();
  registerEngines(); // idempotent
  assert.deepEqual(listRenderers().sort(), [COSMOS_RENDERER_ID, SIGMA_RENDERER_ID].sort());
  assert.equal(
    defaultRendererId(),
    SIGMA_RENDERER_ID,
    "later registration must not steal the default"
  );
  assert.equal(createRenderer(COSMOS_RENDERER_ID).id, COSMOS_RENDERER_ID);
  resetRendererRegistry();
});

// ------------------------------------- the real switch: sigma → cosmos → sigma

test("D4: sigma → cosmos → sigma carries every position, starts no layout, replays focus", () => {
  const { nodes, links } = makeTwoThousandNodeGraph();
  const graph: RendererGraph = { nodes, links };
  const NODES = nodes.length;
  assert.equal(NODES, 2000);

  // -- outgoing: sigma (real engine over the fake DOM) -------------------
  const sigma = createSigmaRenderer();
  const container = makeContainer();
  sigma.mount(container);
  sigma.set(snapshotGraph(graph));
  flushRaf();
  const fromSigma = deepPositions(sigma);
  assert.equal(fromSigma.size, NODES);

  // A focus is live on the sigma engine (what the store would carry).
  sigma.focus("node-42", 7);
  assert.deepEqual((sigma as SigmaRenderer).lastFocus, { nodeId: "node-42", sequence: 7 });

  // -- switch INTO cosmos (headless state-only under Node) ---------------
  const cosmos = createCosmosRenderer();
  cosmos.mount(HEADLESS);
  cosmos.set(withCarriedPositions(snapshotGraph(graph), fromSigma));
  const fromCosmos = deepPositions(cosmos);
  assert.equal(fromCosmos.size, NODES);
  for (const [id, pos] of fromSigma) {
    assert.deepEqual(fromCosmos.get(id), pos, `switch sigma→cosmos must carry position of ${id}`);
  }
  // No layout in flight on either side after the switch (cosmos has none).
  assert.equal((cosmos as CosmosRenderer).setCount, 1);

  // Focus replay: the incoming renderer's gate is cold, so the store's
  // current token (seq 7) re-triggers — the selection keeps the camera.
  assert.equal((cosmos as CosmosRenderer).lastFocus, null, "before replay: nothing focused");
  cosmos.focus("node-42", 7);
  assert.deepEqual((cosmos as CosmosRenderer).lastFocus, { nodeId: "node-42", sequence: 7 });
  cosmos.focus("node-42", 7); // duplicate: gated (V2)
  assert.deepEqual((cosmos as CosmosRenderer).lastFocus, { nodeId: "node-42", sequence: 7 });

  // -- dispose the outgoing renderer (L3/L4) ------------------------------
  sigma.dispose();
  assert.equal(sigma.getPositions().size, 0, "outgoing renderer released its state");

  // -- switch BACK into sigma (a second, fresh instance) ------------------
  const sigma2 = createSigmaRenderer();
  sigma2.mount(makeContainer());
  sigma2.set(withCarriedPositions(snapshotGraph(graph), fromCosmos));
  flushRaf();
  const fromSigma2 = deepPositions(sigma2);
  assert.equal(fromSigma2.size, NODES);
  for (const [id, pos] of fromSigma) {
    assert.deepEqual(fromSigma2.get(id), pos, `round-trip must reproduce ${id} exactly`);
  }
  assert.equal(sigma2.layoutRunning, false, "a switch must NOT start a layout run (no relayout)");
  // And nothing drifts on the next frames — the layout worker is idle.
  flushRaf(8);
  assert.deepEqual(deepPositions(sigma2), fromSigma, "positions are static after a switch");
  // Focus replays on the second incoming renderer too.
  sigma2.focus("node-42", 7);
  assert.deepEqual((sigma2 as SigmaRenderer).lastFocus, { nodeId: "node-42", sequence: 7 });

  sigma2.dispose();
});

test("D4: the switch is idempotent under repeated sets — no positions lost", () => {
  const graph = smallGraph(8);
  const a = createStubRenderer("a");
  a.mount(HEADLESS);
  a.set({
    nodes: graph.nodes.map((n, i) => ({ ...n, x: i * 10, y: i * 10 + 1 })),
    links: graph.links,
  });
  const p1 = deepPositions(a);

  const b = createStubRenderer("b");
  b.mount(HEADLESS);
  b.set(withCarriedPositions(snapshotGraph(graph), p1));
  // A subsequent set() on the INCOMING renderer (e.g. a filter re-run) must
  // keep the carried positions for surviving ids (P2), not re-seed them.
  b.set(withCarriedPositions(snapshotGraph(graph), p1));
  assert.deepEqual(deepPositions(b), p1, "surviving nodes keep their exact positions");
  b.dispose();
  a.dispose();
});

// ----------------------------------------------------- store isolation

test("D4: a switch never touches the store (no refetch, selection intact)", () => {
  // The store is the app's single source of truth (C2). The switch logic in
  // this file (and in use-graph-renderer) works on copies and never calls
  // store.ingest/replaceSlice/select/focus — assert the data a switch would
  // see is stable across it.
  const graph = smallGraph();
  const r1 = createStubRenderer("r1");
  r1.mount(HEADLESS);
  r1.set(snapshotGraph(graph));
  const before = r1.getPositions();
  const r2 = createStubRenderer("r2");
  r2.mount(HEADLESS);
  r2.set(withCarriedPositions(snapshotGraph(graph), before));
  r1.dispose();

  // The logical data (ids/labels/groups/links) is byte-identical after the
  // switch — only renderer-owned positions moved houses.
  assert.deepEqual(
    [...r2.getPositions().keys()].sort(),
    graph.nodes.map((n) => n.id).sort(),
    "no node lost or added by a switch"
  );
  r2.dispose();
});

// ------------------------------------------------------- view-state engine

test("D4/C3: the engine key round-trips through the URL view state", () => {
  const parsed = parseViewState("?engine=cosmos&sel=http%3A%2F%2Fx&theme=light");
  assert.equal(parsed.engine, "cosmos");
  assert.equal(parsed.selectedId, "http://x");
  const back = toSearch({ ...DEFAULT_VIEW_STATE, engine: "cosmos", theme: "light" });
  assert.ok(back.includes("engine=cosmos"), `serialized: ${back}`);
  assert.equal(parseViewState(back).engine, "cosmos");
  // The default is omitted (parse yields null, the hook resolves the default).
  const bare = toSearch(DEFAULT_VIEW_STATE);
  assert.ok(!bare.includes("engine="), `serialized: ${bare}`);
  assert.equal(parseViewState(bare).engine, null);
});
