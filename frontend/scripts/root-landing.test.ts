// Root-entity landing + center-expand continuation (owner directive).
//
// Covers:
//   1. getExpand URL building — limit/offset/relations params, omissions.
//   2. GraphStore center tracking — track/advance/pending + replaceSlice
//      clearing + canExpand via the center chain.
//   3. loadRootSlice / expandCenterPage — the fetch + merge + offset walk,
//      including the relations re-send on continuation pages (offset windows
//      only line up against the SAME filtered stream).
//   4. pickLandingMode — a plain first paint lands on "root", not the ring.
//
// Run: pnpm test (esbuild-bundled by run-contract-tests.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SubgraphResponse } from "../src/api/types";
import { getExpand, setApiBase } from "../src/api/client";
import { ROOT_ENTITY_IRI, ROOT_EXPAND_LIMIT, ROOT_RELATION_NAMES } from "../src/config";
import { GraphStore } from "../src/store/graph-store";
import { expandCenterPage, graphStore, loadRootSlice } from "../src/store/use-graph-store";
import { normalizeRootIri, pickLandingMode } from "../src/lib/aggregate-view";

// ------------------------------------------------------------------ fixtures

const NODE = (id: string, type: string, label: string) => ({
  id,
  label,
  type,
  group: type,
  purl: null,
});
const EDGE = (source: string, target: string, predicate: string) => ({
  id: `${source}->${target}:${predicate}`,
  source,
  target,
  predicate,
  label: predicate.split("/").pop() ?? predicate,
});
const page = (limit: number, cursor: string | null, truncated: boolean) => ({
  cursor,
  limit,
  truncated,
});

function centerSlice(
  extra: number,
  truncated: boolean,
  limit = ROOT_EXPAND_LIMIT
): SubgraphResponse {
  const nodes = [
    NODE(ROOT_ENTITY_IRI, "Organization", "Helmholtz Association"),
    ...Array.from({ length: extra }, (_, i) => NODE(`http://root/n${i}`, "Dataset", `N${i}`)),
  ];
  const edges = nodes.slice(1).map((n) => EDGE(ROOT_ENTITY_IRI, n.id, "https://schema.org/author"));
  return { nodes, edges, page: page(limit, null, truncated) };
}

interface FetchStub {
  calls: string[];
  route: (match: string, payload: unknown) => void;
  restore: () => void;
}

function installFetchStub(): FetchStub {
  const calls: string[] = [];
  const routes: { match: string; payload: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    // LAST registered wins: specific routes can override an earlier
    // catch-all (e.g. an offset page over the plain "/expand/" route).
    const route = [...routes].reverse().find((r) => url.includes(r.match));
    if (!route) throw new Error(`unrouted fetch in test: ${url}`);
    return new Response(JSON.stringify(route.payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    route: (match, payload) => routes.push({ match, payload }),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ----------------------------------------------------------- 1. client URLs

test("getExpand: limit/offset/relations serialize; zero/empty omit", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local/api");
    stub.route("/expand/", centerSlice(1, false));
    await getExpand("http://x/e", {
      limit: 150,
      offset: 300,
      relations: ["author", "https://schema.org/affiliation"],
    });
    const url = stub.calls[0];
    assert.ok(url.includes("limit=150"), url);
    assert.ok(url.includes("offset=300"), url);
    assert.ok(url.includes("relations=author%2C"), url); // joined with ","
    assert.ok(url.startsWith("http://stub.local/api/expand/http%3A%2F%2Fx%2Fe?"), url);
    await getExpand("http://x/e", { limit: 10, offset: 0, relations: [] });
    const plain = stub.calls[1];
    assert.ok(!plain.includes("offset"), plain); // offset 0 omitted
    assert.ok(!plain.includes("relations"), plain); // empty list omitted
  } finally {
    stub.restore();
  }
});

// -------------------------------------------------------- 2. store tracking

test("store: center tracking arms, advances and stops on completion", () => {
  const store = new GraphStore();
  store.replaceSlice(centerSlice(2, true));
  store.trackCenterExpansion(ROOT_ENTITY_IRI, store.page, ["author"]);
  assert.equal(store.canExpand, true);
  assert.equal(store.nextCursor, null); // expand responses carry no cursor
  assert.deepEqual(store.pendingCenterPage, {
    iri: ROOT_ENTITY_IRI,
    offset: ROOT_EXPAND_LIMIT,
    limit: ROOT_EXPAND_LIMIT,
    relations: ["author"],
  });
  store.advanceCenterExpansion(page(ROOT_EXPAND_LIMIT, null, true));
  assert.equal(store.pendingCenterPage?.offset, ROOT_EXPAND_LIMIT * 2);
  store.advanceCenterExpansion(page(ROOT_EXPAND_LIMIT, null, false));
  assert.equal(store.pendingCenterPage, null);
  assert.equal(store.canExpand, false);
  // A fresh replace drops the center chain entirely.
  store.trackCenterExpansion(ROOT_ENTITY_IRI, centerSlice(1, true).page, null);
  store.replaceSlice(centerSlice(1, false));
  assert.equal(store.pendingCenterPage, null);
});

// ------------------------------------------------- 3. root load + paging

test("loadRootSlice: replaces the store with the root subgraph + arms paging", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local/api");
    stub.route("/expand/", centerSlice(3, true));
    await loadRootSlice();
    const url = decodeURIComponent(stub.calls[0]);
    assert.ok(url.includes(ROOT_ENTITY_IRI), url);
    assert.ok(url.includes(`limit=${ROOT_EXPAND_LIMIT}`), url);
    assert.ok(url.includes("relations=affiliation,author"), url);
    assert.equal(graphStore.hasNode(ROOT_ENTITY_IRI), true);
    assert.equal(graphStore.nodeCount, 4);
    assert.equal(graphStore.canExpand, true);
    assert.equal(graphStore.pendingCenterPage?.relations, ROOT_RELATION_NAMES);

    // Continuation: SAME relations stream, window advanced by limit.
    // (Registered FIRST: the stub answers the first matching route.)
    stub.route("offset=", centerSlice(2, false));
    const merged = await expandCenterPage();
    const url2 = stub.calls[1];
    assert.ok(url2.includes(`offset=${ROOT_EXPAND_LIMIT}`), url2);
    assert.ok(url2.includes("relations="), url2); // window must match page 1
    assert.ok(merged !== null);
    assert.equal(graphStore.pendingCenterPage, null); // stream exhausted
    assert.equal(graphStore.canExpand, false);
  } finally {
    stub.restore();
  }
});

// -------------------------------------------------------- 4. landing mode

test("pickLandingMode: plain first paint = root subgraph (not the ring)", () => {
  assert.equal(pickLandingMode({ nextCursor: null, selectedId: null, ov: null }), "root");
  assert.equal(pickLandingMode({ nextCursor: null, selectedId: "s", ov: null }), "slice-restore");
  assert.equal(pickLandingMode({ nextCursor: null, selectedId: null, ov: "Person" }), "ov-restore");
});

test("loadRootSlice: custom root IRI is fetched and tracked for paging", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local/api");
    const custom = "https://ror.org/custom1";
    stub.route("/expand/", centerSlice(2, true));
    await loadRootSlice(undefined, custom);
    assert.ok(decodeURIComponent(stub.calls[0]).includes(custom), stub.calls[0]);
    assert.equal(graphStore.pendingCenterPage?.iri, custom);
  } finally {
    stub.restore();
  }
});

test("normalizeRootIri: trims, requires absolute http(s) IRI", () => {
  assert.equal(normalizeRootIri("  https://ror.org/x  "), "https://ror.org/x");
  assert.equal(normalizeRootIri("http://a.b/c"), "http://a.b/c");
  for (const bad of ["", "   ", "ror.org/x", "ftp://a/b", "https://", "https://a b"]) {
    assert.equal(normalizeRootIri(bad), null, bad);
  }
});
