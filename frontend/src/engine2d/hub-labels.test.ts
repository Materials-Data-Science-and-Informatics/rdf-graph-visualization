import { describe, expect, it } from "vitest";
import { labelCandidates, pickVisible } from "./hub-labels";

describe("hub labels", () => {
  it("skips off-screen and overlapping boxes, keeping priority order", () => {
    const b = (x: number, y: number) => ({ x, y, w: 50, h: 18 });
    expect(
      pickVisible([b(10, 10), b(30, 15), b(100, 10), b(-5, 0), null, b(190, 10)], 200, 100)
    ).toEqual([0, 2]);
  });

  it("puts the root first and caps the hubs", () => {
    const c = {
      community: new Int32Array(0),
      hubs: new Int32Array([5, 0, 7, 9]),
      sizes: new Int32Array([9, 8, 7, 6]),
    };
    expect(labelCandidates(c, 2)).toEqual([0, 5, 7]);
    expect(labelCandidates(null)).toEqual([0]);
  });
});
