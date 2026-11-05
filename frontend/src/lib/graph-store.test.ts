import { describe, expect, it } from "vitest";
import type { StreamEvent } from "./api";
import { GraphStore, OTHER_PREDICATE, shortName } from "./graph-store";

const groups = [
  { name: "Person", color: "#f00" },
  { name: "Institution", color: "#0f0" },
];
const nodes = (hop: number, ...ids: string[]) =>
  ({ type: "nodes", hop, nodes: ids.map((id) => ({ id, group: null })) }) as const;

describe("GraphStore", () => {
  it("applies nodes -> edges -> types -> labels", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a"));
    s.apply(nodes(1, "b", "c"));
    s.apply({
      type: "edges",
      hop: 1,
      edges: [
        { s: "a", p: "http://x/ns#knows", o: "b" },
        { s: "c", p: "http://x/ns/worksAt", o: "a" },
      ],
    });
    s.apply({ type: "types", types: { a: "Person", b: "Institution", c: null, zz: "Person" } });
    s.apply({ type: "labels", labels: { a: "Alice", zz: "ignored" } });
    expect([s.nodeCount, s.edgeCount, s.maxHop]).toEqual([3, 2, 1]);
    expect(Array.from(s.groups.slice(0, 3))).toEqual([0, 1, -1]);
    expect(s.labels.slice(0, 3)).toEqual(["Alice", null, null]);
    expect(s.indexOf("c")).toBe(2);
    expect(s.indexOf("nope")).toBe(-1);
    expect(s.predicateShort).toEqual(["knows", "worksAt"]);
    expect(s.groupColors[1]).toBe("#0f0");
  });

  it("creates nodes lazily from edges", () => {
    const s = new GraphStore(groups);
    s.apply({ type: "edges", hop: 2, edges: [{ s: "a", p: "p", o: "b" }] });
    expect(s.nodeCount).toBe(2);
    expect(s.hops[0]).toBe(2);
  });

  it("grows past the initial capacity", () => {
    const s = new GraphStore(groups);
    const ids = Array.from({ length: 5000 }, (_, i) => `n${i}`);
    s.apply(nodes(0, ...ids));
    s.apply({
      type: "edges",
      hop: 1,
      edges: ids.slice(1).map((id, i) => ({ s: ids[i], p: "p", o: id })),
    });
    expect([s.nodeCount, s.edgeCount]).toEqual([5000, 4999]);
    expect(s.groups[4999]).toBe(-1);
    expect([s.edges[2 * 4998], s.edges[2 * 4998 + 1]]).toEqual([4998, 4999]);
    expect(s.relationsOf(2500)).toHaveLength(2);
  });

  it("reports deltas via takeChanges", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a", "b"));
    let c = s.takeChanges();
    expect([c.newNodeStart, c.newNodeEnd, c.newEdgeEnd, c.empty]).toEqual([0, 2, 0, false]);
    expect(s.takeChanges().empty).toBe(true);
    s.apply({ type: "types", types: { a: "Person" } });
    s.apply({ type: "labels", labels: { b: "B" } });
    s.apply({ type: "edges", hop: 1, edges: [{ s: "a", p: "p", o: "c" }] });
    c = s.takeChanges();
    expect(c.recoloredNodes).toEqual([0]);
    expect(c.relabeledNodes).toEqual([1]);
    expect([c.newNodeStart, c.newNodeEnd, c.newEdgeStart, c.newEdgeEnd]).toEqual([2, 3, 0, 1]);
    expect(c.predicatesChanged).toBe(true);
  });

  it("does not report attributes of new nodes as recolored", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a"));
    s.apply({ type: "types", types: { a: "Person" } });
    expect(s.takeChanges().recoloredNodes).toEqual([]);
  });

  it("relationsOf lists both directions and refreshes after growth", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a", "b", "c"));
    s.apply({ type: "edges", hop: 1, edges: [{ s: "a", p: "http://x#p", o: "b" }] });
    expect(s.relationsOf(1)).toEqual([
      { predicateIndex: 0, predicateShort: "p", dir: "in", otherIndex: 0 },
    ]);
    s.apply({ type: "edges", hop: 1, edges: [{ s: "b", p: "http://x#q", o: "c" }] });
    expect(s.relationsOf(1).map((r) => [r.predicateShort, r.dir, r.otherIndex])).toEqual([
      ["p", "in", 0],
      ["q", "out", 2],
    ]);
  });

  it("reset clears data, keeps groups", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a"));
    const v = s.version;
    s.reset();
    expect([s.nodeCount, s.indexOf("a"), s.takeChanges().empty]).toEqual([0, -1, true]);
    expect(s.version).toBeGreaterThan(v);
    s.apply(nodes(0, "z"));
    s.apply({ type: "types", types: { z: "Institution" } });
    expect(s.groups[0]).toBe(1);
  });
});

describe("shortName", () => {
  it("takes the local name", () => {
    expect(shortName("http://a/b#c")).toBe("c");
    expect(shortName("http://a/b/c")).toBe("c");
    expect(shortName("plain")).toBe("plain");
    expect(shortName("http://a/b/")).toBe("http://a/b/");
  });
});

describe("GraphStore robustness", () => {
  it("increments generation on reset only", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a"));
    const g = s.takeChanges().generation;
    s.apply(nodes(1, "b"));
    expect(s.takeChanges().generation).toBe(g);
    s.reset();
    expect(s.takeChanges().generation).toBe(g + 1);
  });

  it("reserves the last predicate slot as (other)", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a", "b"));
    const edges = Array.from({ length: OTHER_PREDICATE + 3 }, (_, i) => ({
      s: "a",
      p: `http://x/p${i}`,
      o: `b${i}`, // distinct objects: edges of the shared (other) slot are not duplicates
    }));
    s.apply({ type: "edges", hop: 1, edges });
    expect(s.predicates).toHaveLength(OTHER_PREDICATE + 1);
    expect(s.predicates[OTHER_PREDICATE - 1]).toBe(`http://x/p${OTHER_PREDICATE - 1}`);
    expect(s.predicateShort[OTHER_PREDICATE]).toBe("(other)");
    expect(s.edgePredicate[OTHER_PREDICATE]).toBe(OTHER_PREDICATE);
    expect(s.edgePredicate[OTHER_PREDICATE + 2]).toBe(OTHER_PREDICATE);
    expect(s.edgePredicate[OTHER_PREDICATE - 1]).toBe(OTHER_PREDICATE - 1);
  });

  it("refreshes the adjacency when only nodes were added", () => {
    const s = new GraphStore(groups);
    s.apply(nodes(0, "a", "b"));
    s.apply({ type: "edges", hop: 1, edges: [{ s: "a", p: "p", o: "b" }] });
    expect(s.relationsOf(0)).toHaveLength(1);
    s.apply(nodes(1, "c"));
    expect(s.relationsOf(2)).toEqual([]);
  });

  it("ignores edges it already has (re-streamed prefix)", () => {
    const s = new GraphStore(groups);
    const ev: StreamEvent = {
      type: "edges",
      hop: 1,
      edges: [
        { s: "a", p: "p", o: "b" },
        { s: "a", p: "q", o: "b" },
      ],
    };
    s.apply(ev);
    s.apply(ev);
    expect(s.edgeCount).toBe(2);
    s.apply({ type: "edges", hop: 1, edges: [{ s: "a", p: "r", o: "b" }] });
    expect(s.edgeCount).toBe(3);
    s.reset();
    s.apply(ev);
    expect(s.edgeCount).toBe(2);
  });
});
