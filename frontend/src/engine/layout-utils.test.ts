import { describe, expect, it } from "vitest";
import {
  appendWindowEdges,
  buildCsr,
  countToSlider,
  sliderToCount,
  coalesceRanges,
  computeAnchors,
  fitDistance,
  fitFromPositions,
  nextAlpha,
  growCapacity,
  jitterRadius,
  roundCapacity,
  fillVisibility,
} from "./layout-utils";
import { UNTYPED_ALPHA } from "./curve";

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

describe("fitFromPositions", () => {
  it("computes centroid and a percentile radius that ignores outliers", () => {
    const n = 100;
    const pos = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) pos.set([i % 2 ? 1 : -1, 0, 0, 1], i * 4);
    pos.set([1000, 0, 0, 1], 0); // one outlier
    const fit = fitFromPositions(pos, n, 4, 0.95);
    expect(fit.center[0]).toBeGreaterThan(9); // mean pulled by the outlier
    expect(fit.radius).toBeLessThan(20); // but radius is not 1000
    const clean = new Float32Array([1, 0, 0, 1, -1, 0, 0, 1]);
    const f2 = fitFromPositions(clean, 2);
    expect(f2.center).toEqual([0, 0, 0]);
    expect(f2.radius).toBeCloseTo(1);
  });
  it("handles empty input", () => {
    expect(fitFromPositions(new Float32Array(0), 0).radius).toBe(0);
  });
});

describe("fitDistance / nextAlpha", () => {
  it("frames the sphere: r / sin(fov/2) * margin", () => {
    expect(fitDistance(10, 60, 1)).toBeCloseTo(20);
    expect(fitDistance(10, 60)).toBeCloseTo(22);
  });
  it("decays geometrically and freezes below the stop threshold", () => {
    expect(nextAlpha(1, 0.97, 0.002)).toBeCloseTo(0.97);
    expect(nextAlpha(0.002, 0.97, 0.002)).toBe(0);
    let a = 1;
    let frames = 0;
    while (a > 0 && frames < 10_000) {
      a = nextAlpha(a, 0.97, 0.002);
      frames++;
    }
    expect(a).toBe(0);
    expect(frames).toBeLessThan(250);
  });
});

describe("node window", () => {
  const edges = new Uint32Array([0, 1, 1, 2, 2, 7, 3, 3, 0, 9]);
  it("keeps only edges with both endpoints inside the window", () => {
    const dst = new Uint32Array(10);
    const n = appendWindowEdges(edges, 0, 5, 3, dst, 0);
    expect(n).toBe(2);
    expect([...dst.slice(0, 4)]).toEqual([0, 1, 1, 2]);
  });
  it("appends after existing windowed edges", () => {
    const dst = new Uint32Array(10);
    let n = appendWindowEdges(edges, 0, 2, 10, dst, 0);
    n = appendWindowEdges(edges, 2, 5, 10, dst, n);
    expect(n).toBe(5);
    expect([...dst.slice(4, 6)]).toEqual([2, 7]);
  });
  it("builds a CSR only from edges inside the window", () => {
    const dst = new Uint32Array(10);
    const n = appendWindowEdges(edges, 0, 5, 3, dst, 0);
    const offsets = new Uint32Array(5);
    const neigh = new Uint32Array(10);
    expect(buildCsr(dst, n, 3, offsets, neigh)).toBe(4);
    expect([...offsets]).toEqual([0, 1, 3, 4, 4]);
  });
});

describe("log slider", () => {
  it("maps the ends and round-trips the default", () => {
    expect(sliderToCount(0)).toBe(50);
    expect(sliderToCount(1)).toBe(100000);
    expect(sliderToCount(countToSlider(5000))).toBe(5000);
  });
  it("is monotonic", () => {
    expect(sliderToCount(0.3)).toBeLessThan(sliderToCount(0.6));
  });
});

describe("fillVisibility", () => {
  it("treats out-of-range groups as unclassified (-1)", () => {
    const rgba = new Float32Array(16).fill(1);
    fillVisibility(rgba, Int16Array.from([0, -1, 7, 1]), 4, 2, new Set([-1, 1]));
    expect([3, 7, 11, 15].map((i) => rgba[i])).toEqual([1, 0, 0, 0]);
  });
  it("marks visible untyped nodes with UNTYPED_ALPHA", () => {
    const rgba = new Float32Array(12);
    fillVisibility(rgba, Int16Array.from([0, -1, 9]), 3, 2, new Set());
    expect([3, 7, 11].map((i) => rgba[i])).toEqual([1, UNTYPED_ALPHA, UNTYPED_ALPHA]);
  });
});
