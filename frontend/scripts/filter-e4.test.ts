// Card E4 — headless tests for the class filter → slice re-query core.
//
// Covers the pure seams (no React, no DOM, no browser — per owner
// directive; Selections/FilterPanel/Content are thin React bindings over
// these, proven by code path + tsc):
//
//   1. config.ts registry — the Legend and the node colours read the SAME
//      /api/config palette (DoD: "legend matches colours"), the fallback
//      colour, and the URL `type` normalization.
//   2. api/client.ts — getSubgraph serializes the `type` param (DoD:
//      "filter re-queries slice").
//   3. store/use-graph-store.ts — loadFirstPage/expandNextPage/
//      loadToCursor carry the class filter on EVERY page (the cursor and
//      the filter travel together), a filter change replaces the store
//      and resets the cursor chain, stale loads abort.
//   4. view-state.ts — the URL `type` key parse/serialize contract
//      (legacy `hide=` keys are ignored: tolerant by design).
//
// Run: pnpm test (esbuild-bundled here, executed via node --test by
// run-contract-tests.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConfigResponse, SubgraphResponse } from "../src/api/types";
import { setApiBase, getSubgraph } from "../src/api/client";
import {
  FALLBACK_COLOR,
  getGroupColor,
  getPaletteEntries,
  loadConfig,
  typeFilterFromUrl,
} from "../src/config";
import { parseViewState, toSearch } from "../src/view-state";
import {
  expandNextPage,
  graphStore,
  loadFirstPage,
  loadToCursor,
} from "../src/store/use-graph-store";

// ----------------------------------------------------------------- helpers

const NODE = (id: string, group: string) => ({
  id,
  label: id.split("/").pop() ?? id,
  type: group as SubgraphResponse["nodes"][number]["type"],
  group,
  purl: null,
});

const EDGE = (source: string, target: string, predicate: string) => ({
  id: `${source}->${target}:${predicate}`,
  source,
  target,
  predicate,
  label: predicate.split("/").pop() ?? predicate,
});

const page = (limit = 500, cursor: string | null = null, truncated = false) => ({
  limit,
  cursor,
  truncated,
});

const slice = (
  nodes: SubgraphResponse["nodes"],
  cursor: string | null,
  edges: SubgraphResponse["edges"] = []
) => ({
  nodes,
  edges,
  page: page(500, cursor, cursor !== null),
});

const DATASET_PAGE_1 = slice(
  [NODE("http://x/d1", "Dataset"), NODE("http://x/d2", "Dataset")],
  "c1",
  [EDGE("http://x/d1", "http://x/d2", "http://v/hasPart")]
);
const DATASET_PAGE_2 = slice([NODE("http://x/d3", "Dataset")], null);
const PERSON_PAGE_1 = slice([NODE("http://x/p1", "Person"), NODE("http://x/p2", "Person")], "pc1", [
  EDGE("http://x/p1", "http://x/p2", "http://v/worksAt"),
]);
const PERSON_PAGE_2 = slice([NODE("http://x/p3", "Person")], "pc2");
const ALL_PAGE_1 = slice([NODE("http://x/d1", "Dataset"), NODE("http://x/p1", "Person")], "a1", [
  EDGE("http://x/d1", "http://x/p1", "http://v/author"),
]);

const CONFIG: ConfigResponse = {
  relation_properties: ["https://schema.org/hasPart"],
  label_properties: ["https://schema.org/prefName"],
  skip_types: ["https://schema.org/Text"],
  types: [
    { group: "Dataset", type: "Dataset", color: "#0000FF" },
    { group: "Person", type: "Person", color: "#FF0000" },
  ],
};

interface FetchStub {
  calls: { url: string; signal: AbortSignal | null }[];
  route: (match: string, payload: unknown, status?: number) => void;
  /** Route whose response is held until release() — for in-flight overlap. */
  gate: (match: string) => { release: (payload: unknown) => void };
  restore: () => void;
}

function installFetchStub(): FetchStub {
  const calls: { url: string; signal: AbortSignal | null }[] = [];
  const routes: { match: string; payload: unknown; status?: number }[] = [];
  const gates: { match: string; payload: unknown; waiters: (() => void)[]; done: boolean }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal ?? null;
    calls.push({ url, signal });
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    const gate = gates.find((g) => !g.done && url.includes(g.match));
    if (gate) {
      // Woken by release() (proceed) or by the signal's abort (throw).
      const released = await new Promise<boolean>((resolve) => {
        gate.waiters.push(() => resolve(true));
        signal?.addEventListener(
          "abort",
          () => {
            gate.done = true; // one-shot: an aborted gate never traps the next call
            resolve(false);
          },
          { once: true }
        );
      });
      if (!released || signal?.aborted) {
        throw signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(JSON.stringify(gate.payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unrouted fetch in test: ${url}`);
    return new Response(JSON.stringify(route.payload), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    route: (match, payload, status) => routes.push({ match, payload, status }),
    gate: (match) => {
      const entry = { match, payload: null as unknown, waiters: [] as (() => void)[], done: false };
      gates.push(entry);
      return {
        release: (payload: unknown) => {
          entry.payload = payload;
          for (const resolve of entry.waiters) resolve();
        },
      };
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * The graph store is a module-level singleton shared by every test in this
 * bundle — start each store test from a clean slate.
 */
const resetStore = (): void => {
  graphStore.replaceSlice({
    nodes: [],
    edges: [],
    page: { limit: 500, cursor: null, truncated: false },
  });
};

// ------------------------------------------- 1. config registry (legend ≡ nodes)
test("legend and node colours read the same /api/config palette", async () => {
  const stub = installFetchStub();
  stub.route("/config", CONFIG);
  try {
    await loadConfig();
    const entries = getPaletteEntries();
    assert.equal(entries.length, 2);
    // Legend order = /api/config order.
    assert.deepEqual(
      entries.map((e) => e.group),
      ["Dataset", "Person"]
    );
    // The Legend swatch colour and the node colour (getGroupColor) are the
    // same value for every class — DoD: "legend matches colours".
    for (const entry of entries) {
      assert.equal(getGroupColor(entry.group), entry.color);
      // The preset's type is the filter value the panel passes to ?type=.
      assert.equal(entry.type, entry.group);
    }
    assert.equal(getGroupColor("Dataset"), "#0000FF");
    assert.equal(getGroupColor("Person"), "#FF0000");
  } finally {
    stub.restore();
  }
});

test("groups absent from the config (Unknown) fall back to gray", async () => {
  const stub = installFetchStub();
  stub.route("/config", CONFIG);
  try {
    await loadConfig();
    assert.equal(getGroupColor("Unknown"), FALLBACK_COLOR);
    assert.equal(getGroupColor("SomeFutureClass"), FALLBACK_COLOR);
  } finally {
    stub.restore();
  }
});

test("typeFilterFromUrl: live palette values pass, stale values degrade to null", async () => {
  const stub = installFetchStub();
  stub.route("/config", CONFIG);
  try {
    await loadConfig();
    assert.equal(typeFilterFromUrl("Dataset"), "Dataset");
    assert.equal(typeFilterFromUrl("Person"), "Person");
    assert.equal(typeFilterFromUrl("Bogus"), null); // model bump / typo
    assert.equal(typeFilterFromUrl(null), null);
    assert.equal(typeFilterFromUrl(""), null);
  } finally {
    stub.restore();
  }
});

// ------------------------------------------------- 2. client param serialization

test("getSubgraph serializes type/cursor/limit; omits absent params", async () => {
  const stub = installFetchStub();
  stub.route("/subgraph", DATASET_PAGE_1);
  try {
    setApiBase("http://test.local/api");
    await getSubgraph({ type: "Dataset", limit: 50, cursor: "abc" });
    assert.equal(
      stub.calls[0].url,
      "http://test.local/api/subgraph?type=Dataset&limit=50&cursor=abc"
    );
    await getSubgraph({});
    assert.equal(stub.calls[1].url, "http://test.local/api/subgraph");
    await getSubgraph({ type: "Person" });
    assert.equal(stub.calls[2].url, "http://test.local/api/subgraph?type=Person");
  } finally {
    setApiBase("/api");
    stub.restore();
  }
});

// ---------------------------------------------------- 3. store load/expand core

test("filtered first-page load sends ?type= and replaces the store", async () => {
  const stub = installFetchStub();
  stub.route("/subgraph", DATASET_PAGE_1);
  try {
    resetStore();
    await loadFirstPage("Dataset");
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.includes("type=Dataset"));
    assert.ok(!stub.calls[0].url.includes("cursor="), "a fresh load sends no cursor");
    assert.equal(graphStore.nodeCount, 2);
    assert.ok(graphStore.nodes().every((n) => n.group === "Dataset"));
    assert.equal(graphStore.nextCursor, "c1");
  } finally {
    stub.restore();
  }
});

test("unfiltered load sends no type param (all classes, pre-E4 query shape)", async () => {
  const stub = installFetchStub();
  stub.route("/subgraph", ALL_PAGE_1);
  try {
    resetStore();
    await loadFirstPage();
    assert.ok(!stub.calls[0].url.includes("type="));
    await loadFirstPage(null);
    assert.ok(!stub.calls[1].url.includes("type="));
    assert.equal(graphStore.nodeCount, 2);
  } finally {
    stub.restore();
  }
});

test("expand continues the class filter: cursor and type travel together", async () => {
  const stub = installFetchStub();
  // Cursor-aware route first: page 2 answers the cursor-c1 continuation.
  stub.route("cursor=c1", DATASET_PAGE_2);
  stub.route("/subgraph", DATASET_PAGE_1);
  try {
    resetStore();
    await loadFirstPage("Dataset");
    const result = await expandNextPage("Dataset");
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[1].url.includes("type=Dataset"), "the second page keeps the filter");
    assert.ok(stub.calls[1].url.includes("cursor=c1"));
    assert.ok(result, "the expand merged a page");
    assert.equal(graphStore.nodeCount, 3);
    assert.equal(graphStore.nextCursor, null, "slice complete after page 2");
  } finally {
    stub.restore();
  }
});

test("URL cursor-restore chain carries the filter on every page", async () => {
  const stub = installFetchStub();
  // Cursor-aware route first: the continuation page answers cursor=pc1.
  stub.route("cursor=pc1", PERSON_PAGE_2);
  stub.route("/subgraph", PERSON_PAGE_1);
  try {
    resetStore();
    // Page 1 is truncated at pc1; the restore target pc2 means: fetch page
    // 1, then page 2 (cursor pc1, truncated at pc2), then STOP exactly at
    // the shared view's cursor — one cursor-continued page per request,
    // every one carrying the filter.
    await loadToCursor("pc2", "Person");
    assert.equal(stub.calls.length, 2);
    for (const call of stub.calls) {
      assert.ok(call.url.includes("type=Person"), `restore page lost the filter: ${call.url}`);
    }
    assert.ok(stub.calls[1].url.includes("cursor=pc1"));
    assert.equal(graphStore.nodeCount, 3);
    assert.equal(graphStore.nextCursor, "pc2", "the chain stops exactly at the shared cursor");
  } finally {
    stub.restore();
  }
});

test("filter change re-queries: fresh cursor-less request, store replaced, chain reset", async () => {
  const stub = installFetchStub();
  stub.route("type=Person", PERSON_PAGE_1);
  stub.route("type=Dataset", DATASET_PAGE_1);
  try {
    resetStore();
    await loadFirstPage("Dataset");
    assert.equal(graphStore.nextCursor, "c1");
    // The user picks "Person": a NEW slice (no cursor from the old chain).
    await loadFirstPage("Person");
    assert.equal(stub.calls.length, 2);
    assert.ok(
      !stub.calls[1].url.includes("cursor="),
      "a filter change never reuses the old cursor"
    );
    assert.ok(stub.calls[1].url.includes("type=Person"));
    // Store now holds exactly the Person slice; the chain is Person's.
    assert.equal(graphStore.nodeCount, 2);
    assert.ok(graphStore.nodes().every((n) => n.group === "Person"));
    assert.equal(graphStore.nextCursor, "pc1");
  } finally {
    stub.restore();
  }
});

test("a superseded load aborts: late page never lands in the store", async () => {
  const stub = installFetchStub();
  stub.gate("/subgraph");
  try {
    resetStore();
    const controller = new AbortController();
    const pending = loadFirstPage("Dataset", controller.signal);
    const failing = pending.then(
      () => "resolved",
      (err: unknown) => err
    );
    controller.abort();
    const outcome = await failing;
    assert.ok(outcome instanceof DOMException, "caller abort surfaces as AbortError");
    assert.equal(graphStore.nodeCount, 0, "an aborted load replaces nothing");
    // A later load completes normally.
    stub.route("/subgraph", PERSON_PAGE_1);
    await loadFirstPage("Person");
    assert.equal(graphStore.nodeCount, 2);
  } finally {
    stub.restore();
  }
});

test("expand on a complete slice makes no request (C2 regression)", async () => {
  const stub = installFetchStub();
  stub.route("/subgraph", DATASET_PAGE_2);
  try {
    resetStore();
    await loadFirstPage("Dataset");
    assert.equal(graphStore.nextCursor, null);
    const result = await expandNextPage("Dataset");
    assert.equal(result, null);
    assert.equal(stub.calls.length, 1, "no request after a complete slice");
  } finally {
    stub.restore();
  }
});

// ------------------------------------------------------------ 4. view-state URL

test("parse: type key round-trips; absent/empty → null; legacy hide ignored", () => {
  assert.equal(parseViewState("?type=Instrument").typeFilter, "Instrument");
  assert.equal(parseViewState("").typeFilter, null);
  assert.equal(parseViewState("?type=").typeFilter, null);
  // A pre-E4 shared URL with a client-side hide list degrades to "all".
  assert.equal(parseViewState("?hide=Person,Document").typeFilter, null);
});

test("toSearch: type serialized when set, omitted when null, other keys kept", () => {
  const withFilter = toSearch({
    camera: null,
    look: null,
    selectedId: "http://x/p1",
    typeFilter: "Person",
    showIsolated: true,
    theme: "dark",
    nextCursor: null,
  });
  assert.ok(withFilter.includes("type=Person"));
  assert.ok(withFilter.includes("sel=http"));
  assert.ok(withFilter.includes("iso=1"));
  const noFilter = toSearch({
    camera: null,
    look: null,
    selectedId: null,
    typeFilter: null,
    showIsolated: false,
    theme: "dark",
    nextCursor: null,
  });
  assert.equal(noFilter, "");
});

test("URL round-trip keeps the filter, camera and cursor together", () => {
  const original = "?cam=1.000,2.000,3.000&type=Dataset&cursor=zz&sel=http%3A%2F%2Fx%2Fd1";
  const parsed = parseViewState(original);
  assert.equal(parsed.typeFilter, "Dataset");
  assert.equal(parsed.selectedId, "http://x/d1");
  assert.equal(parsed.nextCursor, "zz");
  assert.equal(parsed.camera?.x, 1);
  const reparsed = parseViewState(toSearch(parsed));
  assert.deepEqual(
    { type: reparsed.typeFilter, sel: reparsed.selectedId, cursor: reparsed.nextCursor },
    { type: "Dataset", sel: "http://x/d1", cursor: "zz" }
  );
});
