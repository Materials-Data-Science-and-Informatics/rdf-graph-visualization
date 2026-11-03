// Card D1 — GraphRenderer positions/state contract test (reference run).
//
// Runs the full normative contract (src/render/CONTRACT.md) against the
// HEADLESS STUB adapter (src/render/stub.ts) — the reference implementation.
// The shared suite lives in render-contract-suite.ts; the real adapters run
// the same suite against their own factory (D2: render-sigma.test.ts,
// D3: cosmos.gl).
//
// Run: npm run test
// (scripts/run-contract-tests.mjs bundles each scripts/render-*.test.ts with
// esbuild and runs it with Node's built-in test runner — no test-framework
// dependency.)

import assert from "node:assert/strict";
import { test } from "node:test";

import { createRenderer, createStubRenderer, registerRenderer, seedPosition } from "../src/render";
import type { StubRenderer } from "../src/render";
import { runContractSuite } from "./render-contract-suite";

/** The stub ignores the container; the type requires one. */
const CONTAINER = null as unknown as HTMLElement;

runContractSuite({
  adapterId: "stub",
  makeRenderer: createStubRenderer,
  makeContainer: () => CONTAINER,
  activateNode: (renderer: import("../src/render").GraphRenderer, nodeId: string) => {
    (renderer as StubRenderer).emitNodeSelect(nodeId);
  },
});

// ------------------------------------------------ stub-specific assertions

test("stub P3 seeding equals seedPosition(id) (the reference seeding)", () => {
  const renderer = createStubRenderer();
  renderer.mount(CONTAINER);
  renderer.set({ nodes: [{ id: "a" }], links: [] });
  assert.deepEqual(renderer.getPositions().get("a"), seedPosition("a"));
  renderer.dispose();
});

test("factory returning an instance whose id mismatches the registry key throws", () => {
  registerRenderer("x", () => createStubRenderer("y"));
  assert.throws(() => createRenderer("x"), /id/i);
});
