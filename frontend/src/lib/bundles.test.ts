import { describe, expect, it } from "vitest";
import { detectBundles } from "./bundles";

/** edges as [s, o, p] triples */
function graph(n: number, edges: [number, number, number][], groups?: number[]) {
  const e = new Uint32Array(edges.length * 2);
  const p = new Uint16Array(edges.length);
  edges.forEach(([s, o, pr], i) => {
    e[2 * i] = s;
    e[2 * i + 1] = o;
    p[i] = pr;
  });
  return {
    edges: e,
    edgeCount: edges.length,
    edgePredicate: p,
    groups: Int16Array.from(groups ?? new Array<number>(n).fill(0)),
  };
}

describe("detectBundles", () => {
  it("bundles the 6 members of a K(6,2)", () => {
    // 0 = root, 1,2 = shared, 3..8 = members linked to both shared nodes and the root
    const e: [number, number, number][] = [];
    for (let m = 3; m <= 8; m++) e.push([0, m, 1], [m, 1, 2], [m, 2, 2]);
    expect(detectBundles(graph(9, e), 9)).toEqual([[3, 4, 5, 6, 7, 8]]);
  });

  it("keeps groups below the threshold and respects class, predicate and direction", () => {
    // members 1..k each link to both hubs 6 and 7
    const members = (k: number): [number, number, number][] =>
      Array.from({ length: k }, (_, i) => i + 1).flatMap((m): [number, number, number][] => [
        [m, 6, 0],
        [m, 7, 0],
      ]);
    expect(detectBundles(graph(8, members(4)), 8)).toEqual([]);
    const e2 = members(5);
    expect(detectBundles(graph(8, e2), 8)).toEqual([[1, 2, 3, 4, 5]]);
    expect(detectBundles(graph(8, e2, [0, 0, 0, 0, 0, 1, 0, 0]), 8)).toEqual([]);
    e2[0] = [6, 1, 0]; // different direction
    expect(detectBundles(graph(8, e2), 8)).toEqual([]);
  });

  it("leaves plain leaf siblings (one shared neighbour) alone", () => {
    const e: [number, number, number][] = [];
    for (let m = 1; m <= 8; m++) e.push([m, 9, 0]);
    expect(detectBundles(graph(10, e), 10)).toEqual([]);
  });

  it("never bundles the root or edgeless nodes and ignores edges outside the window", () => {
    const e: [number, number, number][] = [];
    for (let m = 0; m < 6; m++) e.push([m, 6, 0], [m, 7, 0]); // 0 (root) looks like 1..5
    const g = graph(9, e);
    expect(detectBundles(g, 8)).toEqual([[1, 2, 3, 4, 5]]);
    expect(detectBundles(graph(9, [], undefined), 9)).toEqual([]);
    expect(detectBundles(g, 7)).toEqual([]); // hub 7 outside the window: one neighbour left
  });
});
