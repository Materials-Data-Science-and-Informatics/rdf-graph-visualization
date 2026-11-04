// Card E1 — headless tests for the autocomplete → fly-to core.
//
// Covers the three pure seams (no React, no DOM, no browser — per owner
// directive; the React wrapper SearchBox.tsx is a thin binding over these):
//
//   1. SearchSuggest (lib/search-suggest.ts) — debounce, stale-request
//      aborts, char-bound guards, error states. Fake clock + injected fetch.
//   2. GraphStore.ingestEntity + focusEntity (store/) — an out-of-slice
//      search jump merges the /api/expand center + 1 hop WITHOUT clobbering
//      the /api/subgraph cursor chain; an in-slice jump makes zero network
//      calls; failures never select/focus.
//   3. flyCameraPosition (lib/fly-to.ts) — the jump's camera math.
//
// Run: npm run test (esbuild-bundled here, executed via node --test by
// run-contract-tests.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SearchResult, SubgraphResponse } from "../src/api/types";
import { setApiBase } from "../src/api/client";
import { flyCameraPosition, vecDistance } from "../src/lib/fly-to";
import { SearchSuggest } from "../src/lib/search-suggest";
import { GraphStore } from "../src/store/graph-store";
import { focusEntity, graphStore } from "../src/store/use-graph-store";

// ----------------------------------------------------------------- helpers

const NODE = (id: string, group = "Person", label?: string) => ({
  id,
  label: label ?? id,
  type: "Person" as const,
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

/** A fresh main slice: two nodes, one edge, truncated with next page c1. */
const MAIN_SLICE: SubgraphResponse = {
  nodes: [NODE("http://x/n1"), NODE("http://x/n2")],
  edges: [EDGE("http://x/n1", "http://x/n2", "http://v/worksAt")],
  page: page(500, "c1", true),
};

/** An expand slice for an out-of-slice center: center + 2 hops, 1 dangling edge. */
const EXPAND_SLICE: SubgraphResponse = {
  nodes: [
    NODE("http://x/center", "Dataset", "Center"),
    NODE("http://x/a", "Dataset", "A"),
    NODE("http://x/b", "Dataset", "B"),
  ],
  edges: [
    EDGE("http://x/center", "http://x/a", "http://v/hasPart"),
    EDGE("http://x/b", "http://x/center", "http://v/relatedTo"),
    EDGE("http://x/ghost", "http://x/center", "http://v/orphan"), // dangling: ghost unknown
  ],
  page: page(500, null, false),
};

class FakeClock {
  private now = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: { at: number; id: number } | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (next === null || t.at < next.at)) next = { at: t.at, id };
      }
      if (next === null) break;
      const t = this.timers.get(next.id)!;
      this.now = t.at;
      this.timers.delete(next.id);
      t.fn();
    }
    this.now = target;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(id: number | undefined): void {
    if (id !== undefined) this.timers.delete(id);
  }

  get pending(): number {
    return this.timers.size;
  }
}

interface FetchStub {
  calls: { url: string; signal: AbortSignal | null }[];
  route: (match: string, payload: unknown, status?: number) => void;
  restore: () => void;
}

/**
 * Replace global fetch. Routed URLs answer immediately; unrouted URLs
 * reject with a network error (every E1 path is routed explicitly, so an
 * unrouted call is a test bug).
 */
function installFetchStub(): FetchStub {
  const calls: { url: string; signal: AbortSignal | null }[] = [];
  const routes: { match: string; payload: unknown; status?: number }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal ?? null;
    calls.push({ url, signal });
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
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
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const abortError = () => new DOMException("aborted", "AbortError");

/** Drain promise microtasks (fake-clock tests run the event loop by hand). */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------- 1. SearchSuggest (E1 UI)

test("suggest: below minChars stays idle and never queries", () => {
  const clock = new FakeClock();
  const queries: string[] = [];
  const suggest = new SearchSuggest({
    fetchSuggest: async (q) => {
      queries.push(q);
      return [];
    },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  suggest.setText("F");
  assert.equal(suggest.getSnapshot().status, "idle");
  clock.advance(10_000);
  assert.deepEqual(queries, []);
  suggest.dispose();
});

test("suggest: rapid typing coalesces into one debounced query (trimmed)", async () => {
  const clock = new FakeClock();
  const queries: string[] = [];
  const suggest = new SearchSuggest({
    fetchSuggest: async (q) => {
      queries.push(q);
      return [];
    },
    delayMs: 200,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  suggest.setText("For"); // t=0
  clock.advance(50);
  suggest.setText("Fors"); // t=50
  clock.advance(50);
  suggest.setText("  Forschungszentrum "); // t=100
  clock.advance(100); // t=200: still in the debounce window
  assert.equal(queries.length, 0);
  clock.advance(100); // t=300: 200 ms after the last keystroke
  await tick();
  assert.deepEqual(queries, ["Forschungszentrum"]);
  assert.equal(suggest.getSnapshot().status, "done");
  suggest.dispose();
});

test("suggest: stale-abort + late resolution never overwrites the new state", async () => {
  const clock = new FakeClock();
  const fired: { query: string; signal: AbortSignal }[] = [];
  const resolves: ((r: SearchResult[]) => void)[] = [];
  const suggest = new SearchSuggest({
    fetchSuggest: (q, signal) => {
      fired.push({ query: q, signal });
      return new Promise<SearchResult[]>((resolve, reject) => {
        resolves.push(resolve);
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    },
    delayMs: 200,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  suggest.setText("abc");
  clock.advance(200);
  suggest.setText("abcd");
  clock.advance(200);
  assert.equal(fired.length, 2);
  assert.ok(fired[0].signal.aborted, "superseded fetch is aborted");
  assert.ok(!fired[1].signal.aborted);

  // Late resolution of the STALE query must be ignored entirely.
  resolves[0]([{ id: "stale", label: "stale", type: "Unknown" }]);
  await tick();
  assert.equal(suggest.getSnapshot().status, "loading");
  assert.equal(suggest.getSnapshot().query, "abcd");

  // The current query resolves → done with its results.
  resolves[1]([{ id: "live", label: "live", type: "Unknown" }]);
  await tick();
  const snap = suggest.getSnapshot();
  assert.equal(snap.status, "done");
  assert.deepEqual(snap.results, [{ id: "live", label: "live", type: "Unknown" }]);
  suggest.dispose();
});

test("suggest: fetch failure surfaces the message; AbortError is swallowed", async () => {
  const clock = new FakeClock();
  const suggest = new SearchSuggest({
    fetchSuggest: (q) =>
      new Promise<SearchResult[]>((_resolve, reject) => {
        if (q === "boom") reject(new Error("qllever said no"));
        else reject(abortError());
      }),
    delayMs: 200,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  suggest.setText("boom");
  clock.advance(200);
  await tick();
  assert.equal(suggest.getSnapshot().status, "error");
  assert.match(suggest.getSnapshot().error ?? "", /qllever said no/);

  suggest.setText("abort-me");
  clock.advance(200);
  await tick();
  // AbortError is a supersession, not a failure: state stays loading/stale.
  assert.equal(suggest.getSnapshot().status, "loading");
  assert.equal(suggest.getSnapshot().error, null);
  suggest.dispose();
});

test("suggest: over 200 chars errors without firing a request", () => {
  const clock = new FakeClock();
  let fired = 0;
  const suggest = new SearchSuggest({
    fetchSuggest: async () => {
      fired += 1;
      return [];
    },
    delayMs: 200,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  suggest.setText("x".repeat(201));
  assert.equal(suggest.getSnapshot().status, "error");
  assert.match(suggest.getSnapshot().error ?? "", /200/);
  clock.advance(10_000);
  assert.equal(fired, 0);
  suggest.dispose();
});

test("suggest: dispose cancels a pending debounced query", () => {
  const clock = new FakeClock();
  let fired = 0;
  const suggest = new SearchSuggest({
    fetchSuggest: async () => {
      fired += 1;
      return [];
    },
    delayMs: 200,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  suggest.setText("abc");
  suggest.dispose();
  assert.equal(clock.pending, 0);
  clock.advance(10_000);
  assert.equal(fired, 0);
});

test("suggest: snapshot identity is stable until a commit (useSyncExternalStore)", async () => {
  const clock = new FakeClock();
  const suggest = new SearchSuggest({
    fetchSuggest: async () => [],
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (h) => clock.clearTimeout(h as number),
  });
  const a = suggest.getSnapshot();
  const b = suggest.getSnapshot();
  assert.ok(Object.is(a, b));
  suggest.setText("abc");
  clock.advance(200);
  await tick();
  assert.ok(!Object.is(b, suggest.getSnapshot()));
  suggest.dispose();
});

// --------------------------------------------- 2. store paths (E1 fly-to)

test("ingestEntity: merges without touching page/cursor bookkeeping; idempotent", () => {
  const store = new GraphStore();
  store.replaceSlice(MAIN_SLICE);
  assert.equal(store.nextCursor, "c1");
  assert.equal(store.pageCount, 1);

  const merged = store.ingestEntity(EXPAND_SLICE);
  assert.equal(merged.addedNodes, 3);
  assert.equal(merged.addedEdges, 2);
  assert.equal(merged.droppedEdges, 1);
  assert.ok(store.hasNode("http://x/center"));
  assert.equal(store.nodeCount, 5);
  assert.equal(store.edgeCount, 3);

  // The invariant: main-slice continuation state is byte-identical.
  assert.equal(store.nextCursor, "c1");
  assert.equal(store.page?.limit, 500);
  assert.equal(store.page?.cursor, "c1");
  assert.equal(store.pageCount, 1);

  // Idempotent: re-merging the same slice changes no store state. (The
  // dangling edge is re-detected and re-dropped, so droppedEdges repeats.)
  const again = store.ingestEntity(EXPAND_SLICE);
  assert.equal(again.addedNodes, 0);
  assert.equal(again.updatedNodes, 0);
  assert.equal(again.addedEdges, 0);
  assert.equal(again.droppedEdges, 1);
  assert.equal(store.nodeCount, 5);
  assert.equal(store.edgeCount, 3);
});

test("ingest: cursor bookkeeping regression (main path unchanged)", () => {
  const store = new GraphStore();
  store.ingest(MAIN_SLICE); // cursor ""
  const page2: SubgraphResponse = {
    nodes: [NODE("http://x/n3")],
    edges: [],
    page: page(500, "c2", true),
  };
  store.ingest(page2, "c1");
  assert.equal(store.nextCursor, "c2");
  assert.equal(store.pageCount, 2);
});

test("focusEntity: in-slice hit — zero network, select+focus in the same tick", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local");
    graphStore.replaceSlice(MAIN_SLICE);
    const seqBefore = graphStore.focusSequence;
    const merged = await focusEntity("http://x/n1");
    assert.equal(merged, null); // nothing fetched
    assert.equal(stub.calls.length, 0);
    assert.equal(graphStore.selectedId, "http://x/n1");
    assert.equal(graphStore.focusId, "http://x/n1");
    assert.equal(graphStore.focusSequence, seqBefore + 1);
    assert.equal(graphStore.nextCursor, "c1"); // untouched
  } finally {
    stub.restore();
  }
});

test("focusEntity: out-of-slice hit — one expand call, merged, cursor chain intact", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local");
    stub.route("/expand/", EXPAND_SLICE);
    graphStore.replaceSlice(MAIN_SLICE);
    const seqBefore = graphStore.focusSequence;
    const merged = await focusEntity("http://x/center");

    // Exactly one request, percent-encoded IRI.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, "http://stub.local/expand/http%3A%2F%2Fx%2Fcenter");

    // Center + both neighbours merged; the dangling edge dropped.
    assert.ok(graphStore.hasNode("http://x/center"));
    assert.ok(graphStore.hasNode("http://x/a"));
    assert.ok(graphStore.hasNode("http://x/b"));
    assert.equal(merged?.addedNodes, 3);
    assert.equal(merged?.addedEdges, 2);
    assert.equal(merged?.droppedEdges, 1);

    // Selection + focus bumped.
    assert.equal(graphStore.selectedId, "http://x/center");
    assert.equal(graphStore.focusSequence, seqBefore + 1);

    // THE invariant: the /api/subgraph continuation survived the jump.
    assert.equal(graphStore.nextCursor, "c1");
    assert.equal(graphStore.page?.limit, 500);
    assert.equal(graphStore.page?.cursor, "c1");
    assert.equal(graphStore.pageCount, 1);

    // A second focus of the same (now in-store) node makes no new request.
    await focusEntity("http://x/center");
    assert.equal(stub.calls.length, 1);
    assert.equal(graphStore.focusSequence, seqBefore + 2);
  } finally {
    stub.restore();
  }
});

test("focusEntity: expand slice missing the center — rejects, nothing selected", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local");
    stub.route("/expand/", {
      nodes: [NODE("http://x/a", "Dataset", "A")], // no center
      edges: [],
      page: page(500, null, false),
    });
    graphStore.replaceSlice(MAIN_SLICE);
    const seqBefore = graphStore.focusSequence;
    await assert.rejects(focusEntity("http://x/vanished"), /not present in its expand slice/);
    assert.equal(graphStore.selectedId, null);
    assert.equal(graphStore.focusSequence, seqBefore);
  } finally {
    stub.restore();
  }
});

test("focusEntity: backend 500 — error message propagates, nothing selected", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local");
    stub.route("/expand/", { detail: "qllever exploded" }, 500);
    graphStore.replaceSlice(MAIN_SLICE);
    const seqBefore = graphStore.focusSequence;
    let err: unknown;
    try {
      await focusEntity("http://x/center");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error);
    assert.match(String((err as Error).message), /500/);
    assert.match(String((err as Error).message), /qllever exploded/);
    assert.equal(graphStore.selectedId, null);
    assert.equal(graphStore.focusSequence, seqBefore);
  } finally {
    stub.restore();
  }
});

test("focusEntity: caller abort — AbortError surfaces, nothing selected", async () => {
  const stub = installFetchStub();
  try {
    setApiBase("http://stub.local");
    graphStore.replaceSlice(MAIN_SLICE);
    const seqBefore = graphStore.focusSequence;
    const ac = new AbortController();
    ac.abort();
    let err: unknown;
    try {
      await focusEntity("http://x/center", ac.signal);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof DOMException, `expected DOMException, got ${String(err)}`);
    assert.equal((err as DOMException).name, "AbortError");
    assert.equal(graphStore.selectedId, null);
    assert.equal(graphStore.focusSequence, seqBefore);
  } finally {
    stub.restore();
  }
});

// ------------------------------------------------ 3. fly-to camera math

test("flyCameraPosition: keeps the current view direction, at the fixed distance", () => {
  const node = { x: 0, y: 0, z: 0 };
  // Camera looking down -Z at the origin → jump goes back along +Z.
  const pos = flyCameraPosition(node, { x: 0, y: 0, z: 100 }, 180);
  assert.deepEqual(pos, { x: 0, y: 0, z: 180 });
  // Oblique camera keeps its own direction, normalised.
  const pos2 = flyCameraPosition(node, { x: 100, y: 0, z: 0 }, 180);
  assert.deepEqual(pos2, { x: 180, y: 0, z: 0 });
});

test("flyCameraPosition: works for off-origin nodes and scales with distance", () => {
  const node = { x: 10, y: 20, z: 30 };
  const pos = flyCameraPosition(node, { x: 10, y: 20, z: 130 }, 180);
  assert.deepEqual(pos, { x: 10, y: 20, z: 210 });
  const pos2 = flyCameraPosition(node, { x: 10, y: 20, z: 130 }, 360);
  assert.deepEqual(pos2, { x: 10, y: 20, z: 390 });
});

test("flyCameraPosition: co-located camera falls back to the default direction", () => {
  const node = { x: 0, y: 0, z: 0 };
  const pos = flyCameraPosition(node, { x: 0, y: 0, z: 0 }, 100);
  const expectedLen = Math.hypot(0, 0.45, 1);
  assert.ok(Math.abs(pos.x) < 1e-9);
  assert.ok(Math.abs(pos.y - (0.45 / expectedLen) * 100) < 1e-9);
  assert.ok(Math.abs(pos.z - (1 / expectedLen) * 100) < 1e-9);
});

test("vecDistance: euclidean", () => {
  assert.equal(vecDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(vecDistance({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), 0);
});
