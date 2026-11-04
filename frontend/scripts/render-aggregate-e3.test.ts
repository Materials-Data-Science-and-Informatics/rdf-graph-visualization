// Card E3 S1 — aggregate cluster layer: headless tests for the pure model
// (lib/aggregate-view.ts) and the overview store (store/overview-store.ts).
//
// No React, no DOM, no browser, no network: the store is constructed with a
// fresh GraphStore and an injectable fake client, mirroring the render
// contract test style of this repo (node:test via run-contract-tests.mjs).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CLUSTER_RADIUS_MAX,
  CLUSTER_RADIUS_MIN,
  AggregateContractError,
  clusterId,
  clusterRadius,
  clusterType,
  clustersToGraphData,
  formatCount,
  pickLandingMode,
  validateAggregate,
} from "../src/lib/aggregate-view";
import { OverviewStore, type OverviewClient } from "../src/store/overview-store";
import { GraphStore } from "../src/store/graph-store";
import type {
  AggregateNode,
  AggregateResponse,
  NodeType,
  SubgraphResponse,
} from "../src/api/types";

// The live dev-endpoint aggregate (card B4 DoD run): the "Unknown" bucket
// dominates; Document/Institution have zero instances and are absent.
const LIVE_AGGREGATE: AggregateNode[] = [
  { group: "Unknown", type: "Unknown", count: 45742521 },
  { group: "Person", type: "Person", count: 33170250 },
  { group: "Dataset", type: "Dataset", count: 562235 },
  { group: "DataCatalog", type: "DataCatalog", count: 9375 },
  { group: "Event", type: "Event", count: 4643 },
  { group: "Software", type: "Software", count: 3 },
];

function aggregateOf(rows: AggregateNode[]): { nodes: AggregateNode[] } {
  return { nodes: rows };
}

function sliceFor(type: string | undefined, nodeCount: number): SubgraphResponse {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `http://example.org/${type ?? "entity"}/${i}`,
    label: `${type ?? "entity"} ${i}`,
    type: (type ?? "Dataset") as NodeType,
    group: type ?? "Dataset",
  }));
  const edges = [];
  for (let i = 1; i < nodeCount; i += 1) {
    edges.push({
      id: `edge-${i}`,
      source: nodes[i - 1].id,
      target: nodes[i].id,
      predicate: "http://schema.org/relatesTo",
      label: "relatesTo",
    });
  }
  return { nodes, edges, page: { limit: nodeCount, truncated: false } };
}

interface FakeClient {
  client: OverviewClient;
  aggregateCalls: number;
  subgraphQueries: { type?: NodeType }[];
  aggregateImpl: () => AggregateNode[];
  subgraphImpl: (type?: string) => SubgraphResponse;
  /** Gate to hold a subgraph fetch open (abort tests). */
  releaseSubgraph: () => void;
  subgraphPending: () => boolean;
}

function makeFakeClient(): FakeClient {
  const abortError = () => new DOMException("The operation was aborted.", "AbortError");
  let resolveGate: (() => void) | null = null;
  let gated = false;
  const gate = (): Promise<void> =>
    gated ? new Promise<void>((r) => (resolveGate = r)) : Promise.resolve();
  const fake: FakeClient = {
    client: {
      aggregate: async (options) => {
        fake.aggregateCalls += 1;
        if (options?.signal?.aborted) throw abortError();
        return aggregateOf(fake.aggregateImpl());
      },
      subgraph: async (query, options) => {
        fake.subgraphQueries.push(query);
        if (options?.signal?.aborted) throw abortError();
        await gate();
        if (options?.signal?.aborted) throw abortError();
        return fake.subgraphImpl(query.type);
      },
    },
    aggregateCalls: 0,
    subgraphQueries: [],
    aggregateImpl: () => LIVE_AGGREGATE,
    subgraphImpl: (type) => sliceFor(type, 4),
    releaseSubgraph: () => {
      resolveGate?.();
      resolveGate = null;
      gated = false;
    },
    subgraphPending: () => resolveGate !== null,
  };
  return fake;
}

// ------------------------------------------------------------ format/sizing

describe("formatCount", () => {
  it("digit-groups below 10k", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(1), "1");
    assert.equal(formatCount(9375), "9,375");
    assert.equal(formatCount(9999), "9,999");
  });
  it("uses k/M/B with one decimal, dropping trailing .0", () => {
    assert.equal(formatCount(10000), "10k");
    assert.equal(formatCount(562235), "562.2k");
    assert.equal(formatCount(33170250), "33.2M");
    assert.equal(formatCount(45742521), "45.7M");
    assert.equal(formatCount(1_000_000_000), "1B");
    assert.equal(formatCount(1_234_567_890), "1.2B");
  });
  it("rejects non-finite or negative counts", () => {
    assert.throws(() => formatCount(-1));
    assert.throws(() => formatCount(Number.NaN));
  });
});

describe("clusterRadius", () => {
  it("is monotonic in the count and clamped", () => {
    const counts = [0, 3, 4643, 9375, 562235, 33170250, 45742521, 1e15];
    let prev = CLUSTER_RADIUS_MIN - 1;
    for (const c of counts) {
      const r = clusterRadius(c);
      assert.ok(r >= CLUSTER_RADIUS_MIN && r <= CLUSTER_RADIUS_MAX);
      assert.ok(r >= prev);
      prev = r;
    }
    // 3 vs 45.7M must not be more than ~6x apart (log scale stays on-screen)
    assert.ok(clusterRadius(45742521) / clusterRadius(3) < 6);
  });
});

describe("cluster id round-trip", () => {
  it("maps types to prefixed ids and back", () => {
    assert.equal(clusterId("Person"), "cluster:Person");
    assert.equal(clusterType("cluster:Person"), "Person");
    assert.equal(clusterType("http://example.org/person/1"), null);
  });
});

// -------------------------------------------------------- contract checking

describe("validateAggregate", () => {
  it("passes valid rows through, re-sorted count-descending with group tie-break", () => {
    const shuffled = [...LIVE_AGGREGATE].reverse();
    const out = validateAggregate(aggregateOf(shuffled));
    assert.deepEqual(
      out.map((r) => [r.type, r.count]),
      LIVE_AGGREGATE.map((r) => [r.type, r.count])
    );
  });

  it("accepts the empty aggregate (a zero-row dataset)", () => {
    assert.deepEqual(validateAggregate(aggregateOf([])), []);
  });

  it("rejects contract violations", () => {
    const tenRows = Array.from({ length: 10 }, (_, i) => ({
      group: `G${i}`,
      type: `G${i}`,
      count: i,
    }));
    const bad: unknown[] = [
      null,
      { nodes: "nope" },
      { nodes: tenRows }, // 10 rows
      { nodes: [{ group: "Person", type: "Person", count: 1.5 }] },
      { nodes: [{ group: "Person", type: "Person", count: -1 }] },
      { nodes: [{ type: "Person", count: 1 }] },
      { nodes: [{ group: "", type: "Person", count: 1 }] },
      { nodes: [{ group: "Person", type: "", count: 1 }] },
      { nodes: [42] },
    ];
    for (const row of bad) {
      assert.throws(
        () => validateAggregate(row as { nodes: AggregateNode[] }),
        AggregateContractError
      );
    }
  });
});

// ------------------------------------------------------------ cluster data

describe("clustersToGraphData", () => {
  it("builds one typed node per row plus a closing ring of links", () => {
    const data = clustersToGraphData(LIVE_AGGREGATE);
    assert.equal(data.nodes.length, 6);
    assert.equal(data.links.length, 6); // 5 chain + 1 closing
    const person = data.nodes.find((n) => n.id === clusterId("Person"));
    if (person === undefined) throw new Error("Person cluster node missing");
    assert.equal(person.label, "Person · 33.2M");
    assert.equal(person.group, "Person");
    assert.equal(person.count, 33170250);
    const first = data.links[0];
    assert.equal(first.source, data.nodes[0].id);
    assert.equal(first.target, data.nodes[1].id);
    const close = data.links[data.links.length - 1];
    assert.equal(close.source, data.nodes[5].id);
    assert.equal(close.target, data.nodes[0].id);
    assert.equal(close.id, "cluster-link-close");
  });

  it("degenerates: 0 rows -> empty, 1 row -> no links, 2 rows -> one link", () => {
    assert.deepEqual(clustersToGraphData([]), { nodes: [], links: [] });
    assert.equal(clustersToGraphData([LIVE_AGGREGATE[5]]).links.length, 0);
    assert.equal(clustersToGraphData(LIVE_AGGREGATE.slice(0, 2)).links.length, 1);
  });
});

// ------------------------------------------------------------ landing mode

describe("pickLandingMode", () => {
  it("ov wins over plain slice deep links; cursor/sel restore the legacy view", () => {
    // A typed cluster deep link is more specific: the `cursor` next to `ov`
    // belongs to that typed slice.
    assert.equal(
      pickLandingMode({ nextCursor: "c1", selectedId: null, ov: "Person" }),
      "ov-restore"
    );
    assert.equal(
      pickLandingMode({ nextCursor: null, selectedId: "http://x/1", ov: "Person" }),
      "ov-restore"
    );
    assert.equal(
      pickLandingMode({ nextCursor: null, selectedId: null, ov: "Person" }),
      "ov-restore"
    );
    assert.equal(
      pickLandingMode({ nextCursor: "c1", selectedId: null, ov: null }),
      "slice-restore"
    );
    assert.equal(
      pickLandingMode({ nextCursor: null, selectedId: "http://x/1", ov: null }),
      "slice-restore"
    );
    assert.equal(pickLandingMode({ nextCursor: null, selectedId: null, ov: null }), "overview");
  });
});

// --------------------------------------------------- URL view-state (ov key)

describe("view-state ov key (card E3 S3)", () => {
  it("parses, serializes and round-trips the expanded cluster", async () => {
    const { DEFAULT_VIEW_STATE, parseViewState, toSearch } = await import("../src/view-state");
    assert.equal(parseViewState("").ov, null);
    assert.equal(parseViewState("?ov=Person&cursor=c2").ov, "Person");
    const state = { ...DEFAULT_VIEW_STATE, ov: "Person", nextCursor: "c2" };
    const search = toSearch(state);
    assert.match(search, /ov=Person/);
    assert.equal(parseViewState(`?${search}`).ov, "Person");
    // defaults omitted: no ov key in the search string
    assert.doesNotMatch(toSearch(DEFAULT_VIEW_STATE), /ov=/);
  });
});

// ------------------------------------------------------- restoreExpanded

describe("OverviewStore.restoreExpanded (shared cluster URL)", () => {
  function pagedFake() {
    const fake = makeFakeClient();
    fake.client.subgraph = async (query, options) => {
      fake.subgraphQueries.push(query);
      if (options?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (!query.cursor) {
        return {
          nodes: [
            { id: "http://x/p1", label: "p1", type: "Person" as NodeType, group: "Person" },
            { id: "http://x/p2", label: "p2", type: "Person" as NodeType, group: "Person" },
          ],
          edges: [],
          page: { cursor: "c2", limit: 2, truncated: true },
        };
      }
      if (query.cursor === "c2") {
        return {
          nodes: [{ id: "http://x/p3", label: "p3", type: "Person" as NodeType, group: "Person" }],
          edges: [],
          page: { limit: 1, truncated: false },
        };
      }
      throw new Error(`unexpected cursor ${query.cursor}`);
    };
    return fake;
  }

  it("fetches the typed first page; the target cursor marks the shared pending page", async () => {
    const fake = pagedFake();
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();
    await store.restoreExpanded("Person", "c2");
    // C3 semantics: the URL cursor is the page still PENDING at share time,
    // so the store holds exactly the pages before it (typed page 1 only).
    assert.equal(graph.nodeCount, 2);
    assert.equal(store.activeType, "Person");
    assert.equal(store.view, "slice");
    assert.equal(graph.nextCursor, "c2");
    assert.deepEqual(fake.subgraphQueries, [{ type: "Person" }]);
  });

  it("stops early when the slice runs out before the target cursor", async () => {
    const fake = pagedFake();
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();
    await store.restoreExpanded("Person", "c-unreachable");
    // page 1 (cursor c2) + page 2 (complete) — then the slice runs out
    assert.equal(graph.nodeCount, 3);
    assert.equal(graph.nextCursor, null);
  });

  it("an aborted restore leaves a consistent (possibly partial) state", async () => {
    const fake = pagedFake();
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();
    const controller = new AbortController();
    void controller.abort();
    const result = await store.restoreExpanded("Person", "c2", controller.signal);
    assert.equal(result, null);
    assert.equal(store.view, "clusters"); // expand never switched views
    assert.equal(graph.nodeCount, 0);
  });
});

// ---------------------------------------------------------------- the store

describe("OverviewStore.load", () => {
  it("reaches ready with the validated clusters", async () => {
    const fake = makeFakeClient();
    const store = new OverviewStore(new GraphStore(), fake.client);
    assert.equal(store.status, "idle");
    await store.load();
    assert.equal(store.status, "ready");
    assert.equal(store.error, null);
    assert.deepEqual(store.clusters, LIVE_AGGREGATE);
    assert.equal(store.isClusterView, true);
    assert.equal(fake.aggregateCalls, 1);
  });

  it("records a fetch failure as the error state", async () => {
    const fake = makeFakeClient();
    fake.aggregateImpl = () => {
      throw new Error("aggregate exploded");
    };
    const store = new OverviewStore(new GraphStore(), fake.client);
    await store.load();
    assert.equal(store.status, "error");
    assert.match(store.error ?? "", /aggregate exploded/);
    assert.equal(store.isClusterView, false);
  });

  it("an aborted load lands back on idle without an error", async () => {
    const fake = makeFakeClient();
    const controller = new AbortController();
    controller.abort();
    const store = new OverviewStore(new GraphStore(), fake.client);
    await store.load(controller.signal);
    assert.equal(store.status, "idle");
    assert.equal(store.error, null);
  });

  it("a superseded load never writes state", async () => {
    let firstResolve: ((rows: AggregateResponse) => void) | null = null;
    const fake = makeFakeClient();
    let call = 0;
    fake.client.aggregate = () => {
      call += 1;
      if (call === 1) return new Promise<AggregateResponse>((resolve) => (firstResolve = resolve));
      return Promise.resolve(aggregateOf(LIVE_AGGREGATE));
    };
    const store = new OverviewStore(new GraphStore(), fake.client);
    const stale = store.load();
    const fresh = store.load(); // supersedes
    await fresh;
    firstResolve!(aggregateOf(LIVE_AGGREGATE.map((r) => ({ ...r })).reverse()));
    await stale;
    // The fresh (second) load's result is what is cached, in canonical order.
    assert.equal(store.status, "ready");
    assert.deepEqual(store.clusters, LIVE_AGGREGATE);
  });
});

describe("OverviewStore.expand (expand-on-click)", () => {
  it("fetches the typed slice and replaces the graph store", async () => {
    const fake = makeFakeClient();
    fake.subgraphImpl = (type) => sliceFor(type, 7);
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();

    const merge = await store.expand("Dataset");
    assert.ok(merge);
    assert.equal(store.view, "slice");
    assert.equal(store.activeType, "Dataset");
    assert.equal(store.isClusterView, false);
    assert.equal(graph.nodeCount, 7);
    assert.equal(graph.edges().length, 6);
    assert.deepEqual(fake.subgraphQueries, [{ type: "Dataset" }]);
  });

  it("a second expand while one is in flight is a no-op", async () => {
    const fake = makeFakeClient();
    fake.client.subgraph = async (query) => {
      fake.subgraphQueries.push(query);
      await new Promise((r) => setTimeout(r, 20));
      return fake.subgraphImpl(query.type);
    };
    const store = new OverviewStore(new GraphStore(), fake.client);
    await store.load();
    const a = store.expand("Person");
    const b = await store.expand("Dataset");
    assert.equal(b, null);
    await a;
    assert.equal(store.activeType, "Person");
    assert.equal(fake.subgraphQueries.length, 1);
  });

  it("an aborted expand leaves the graph store and the view untouched", async () => {
    const fake = makeFakeClient();
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();
    const controller = new AbortController();
    const pending = store.expand("Event", controller.signal);
    controller.abort();
    const result = await pending;
    assert.equal(result, null);
    assert.equal(store.view, "clusters");
    assert.equal(store.activeType, null);
    assert.equal(store.expandError, null);
    assert.equal(graph.nodeCount, 0);
  });

  it("a failed expand records expandError and keeps the cluster view", async () => {
    const fake = makeFakeClient();
    fake.client.subgraph = async () => {
      throw new Error("subgraph exploded");
    };
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();
    const result = await store.expand("Software");
    assert.equal(result, null);
    assert.equal(store.view, "clusters");
    assert.equal(store.isClusterView, true);
    assert.match(store.expandError ?? "", /subgraph exploded/);
    assert.equal(graph.nodeCount, 0);
  });
});

describe("OverviewStore cluster data (S2 wiring contract)", () => {
  it("exposes a stable clusterData reference while the ring is on screen", async () => {
    const fake = makeFakeClient();
    const store = new OverviewStore(new GraphStore(), fake.client);
    assert.equal(store.clusterData, null);
    await store.load();
    const first = store.clusterData;
    assert.ok(first !== null);
    assert.equal(store.clusterData, first); // stable across reads
    assert.equal(first!.nodes.length, LIVE_AGGREGATE.length);
    assert.equal(first!.links.length, LIVE_AGGREGATE.length); // ring
    // leaving the ring hides the data without losing the cached copy
    store.enterSlice();
    assert.equal(store.clusterData, null);
    // back to the ring: same cached reference (no rebuild)
    store.collapse();
    assert.equal(store.clusterData, first);
  });

  it("lastExpandType records the attempt so a failure is retryable", async () => {
    const fake = makeFakeClient();
    fake.client.subgraph = async () => {
      throw new Error("subgraph exploded");
    };
    const store = new OverviewStore(new GraphStore(), fake.client);
    await store.load();
    assert.equal(store.lastExpandType, null);
    await store.expand("Event");
    assert.equal(store.lastExpandType, "Event");
    assert.match(store.expandError ?? "", /subgraph exploded/);
  });
});

describe("OverviewStore view transitions", () => {
  it("collapse returns to the cluster layer and clears the active type", async () => {
    const fake = makeFakeClient();
    const graph = new GraphStore();
    const store = new OverviewStore(graph, fake.client);
    await store.load();
    await store.expand("Person");
    assert.equal(store.view, "slice");
    store.collapse();
    assert.equal(store.view, "clusters");
    assert.equal(store.activeType, null);
    assert.equal(store.isClusterView, true);
    // The fetched slice stays in the graph store (no refetch to go back).
    assert.equal(graph.nodeCount, 4);
  });

  it("enterSlice switches to a plain slice without an active type", async () => {
    const fake = makeFakeClient();
    const store = new OverviewStore(new GraphStore(), fake.client);
    await store.load();
    store.enterSlice();
    assert.equal(store.view, "slice");
    assert.equal(store.activeType, null);
    assert.equal(store.isClusterView, false);
  });

  it("enterSlice clears an expanded cluster (a plain reload drops ov state)", async () => {
    const fake = makeFakeClient();
    const store = new OverviewStore(new GraphStore(), fake.client);
    await store.load();
    await store.expand("Person");
    assert.equal(store.activeType, "Person");
    store.enterSlice();
    assert.equal(store.view, "slice");
    assert.equal(store.activeType, null);
    // already a plain slice: no state change (no emit)
    const snapshot = store.getSnapshot();
    store.enterSlice();
    assert.equal(store.getSnapshot(), snapshot);
  });
});
