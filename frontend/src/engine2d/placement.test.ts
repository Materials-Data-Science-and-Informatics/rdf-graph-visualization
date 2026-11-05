import { describe, expect, it } from "vitest";
import { placeCarried, placeNodes } from "./placement";

describe("placeNodes", () => {
  it("keeps placed nodes and spawns new ones next to their neighbour", () => {
    const prev = new Float32Array([100, 100, 500, 500]);
    const edges = new Uint32Array([0, 2, 1, 3]);
    const out = placeNodes(prev, 2, 4, edges, 2, 2048, () => 0.5);
    expect([...out.slice(0, 4)]).toEqual([100, 100, 500, 500]);
    expect(Math.hypot(out[4] - 100, out[5] - 100)).toBeLessThan(40);
    expect(Math.hypot(out[6] - 500, out[7] - 500)).toBeLessThan(40);
  });

  it("puts unconnected new nodes near the centre", () => {
    const out = placeNodes(new Float32Array(0), 0, 2, new Uint32Array(0), 0, 2048, () => 0.5);
    expect(Math.hypot(out[0] - 2048, out[1] - 2048)).toBeLessThan(200);
  });
});

describe("placeCarried", () => {
  it("keeps positions by id and seeds new nodes next to known neighbours", () => {
    const prev = new Float32Array([100, 100, 500, 500]);
    const edges = new Uint32Array([0, 1, 1, 2]);
    const { pos, carried } = placeCarried(
      prev,
      ["a", "b"],
      2,
      ["b", "c", "a"],
      edges,
      2,
      2048,
      () => 0.5
    );
    expect(carried).toBe(2);
    expect([...pos.slice(0, 2)]).toEqual([500, 500]);
    expect([...pos.slice(4, 6)]).toEqual([100, 100]);
    expect(Math.hypot(pos[2] - 500, pos[3] - 500)).toBeLessThan(40);
  });
});
