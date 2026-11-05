import { describe, expect, it } from "vitest";
import {
  buildCsr,
  coalesceRanges,
  computeAnchors,
  growCapacity,
  jitterRadius,
  roundCapacity,
} from "./layout-utils";

describe("capacity", () => {
  it("rounds up with headroom to a multiple of 4096", () => {
    expect(roundCapacity(1)).toBe(4096);
    expect(roundCapacity(100_000)).toBe(110_592); // 110000 -> 27 * 4096
    expect(roundCapacity(100_000) % 4096).toBe(0);
    expect(roundCapacity(100_000)).toBeGreaterThanOrEqual(100_000);
  });
  it("grows by doubling until it fits", () => {
    expect(growCapacity(4096, 4096)).toBe(4096);
    expect(growCapacity(4096, 4097)).toBe(8192);
    expect(growCapacity(4096, 40_000)).toBe(65_536);
  });
});

describe("buildCsr", () => {
  it("builds both directions, skips self loops, pads trailing offsets", () => {
    const edges = new Uint32Array([0, 1, 1, 2, 2, 2, 0, 2]);
    const offsets = new Uint32Array(8);
    const neigh = new Uint32Array(8);
    const total = buildCsr(edges, 4, 3, offsets, neigh);
    expect(total).toBe(6);
    expect([...offsets]).toEqual([0, 2, 4, 6, 6, 6, 6, 6]);
    expect([...neigh.slice(offsets[0], offsets[1])].sort()).toEqual([1, 2]);
    expect([...neigh.slice(offsets[1], offsets[2])].sort()).toEqual([0, 2]);
    expect([...neigh.slice(offsets[2], offsets[3])].sort()).toEqual([0, 1]);
  });
  it("handles an empty graph", () => {
    const offsets = new Uint32Array(4).fill(9);
    expect(buildCsr(new Uint32Array(0), 0, 0, offsets, new Uint32Array(0))).toBe(0);
    expect([...offsets]).toEqual([0, 0, 0, 0]);
  });
});

describe("computeAnchors", () => {
  it("anchors new nodes at the lower endpoint of their first new edge", () => {
    // nodes 0..2 exist, 3 and 4 are new; edges: 3-1, 4-3 (4 -> chain through 3 -> 1)
    const edges = new Uint32Array([0, 1, 1, 2, 3, 1, 4, 3]);
    const { anchor, depth } = computeAnchors(edges, 2, 4, 3, 5);
    expect([...anchor]).toEqual([1, 1]);
    expect([...depth]).toEqual([0, 1]);
  });
  it("gives -1 to nodes without a new edge and to the root", () => {
    const { anchor } = computeAnchors(new Uint32Array(0), 0, 0, 0, 2);
    expect([...anchor]).toEqual([-1, -1]);
  });
  it("is empty for an empty node window", () => {
    expect(computeAnchors(new Uint32Array(0), 0, 0, 5, 5).anchor.length).toBe(0);
  });
  it("jitter grows with depth but is capped", () => {
    expect(jitterRadius(10, 0)).toBeLessThan(jitterRadius(10, 3));
    expect(jitterRadius(10, 1000)).toBe(30);
  });
});

describe("coalesceRanges", () => {
  it("sorts, dedupes and merges adjacent indices", () => {
    expect(coalesceRanges([5, 1, 2, 3, 3, 9])).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
      { start: 9, end: 10 },
    ]);
  });
  it("merges across small gaps when asked", () => {
    expect(coalesceRanges([1, 3, 10], 1)).toEqual([
      { start: 1, end: 4 },
      { start: 10, end: 11 },
    ]);
  });
  it("returns [] for no input", () => {
    expect(coalesceRanges([])).toEqual([]);
  });
});
