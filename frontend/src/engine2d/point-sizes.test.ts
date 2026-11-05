import { describe, expect, it } from "vitest";
import { BASE_SIZE, MAX_SIZE, ROOT_SIZE, computeDegrees, computePointSizes } from "./point-sizes";

describe("point sizes", () => {
  it("grows with degree, capped, root largest", () => {
    const edges = new Uint32Array([0, 1, 1, 2, 1, 3]);
    const s = computePointSizes(4, computeDegrees(4, edges, 3));
    expect(s[0]).toBe(ROOT_SIZE);
    expect(s[1]).toBeGreaterThan(s[2]);
    expect(s[2]).toBeGreaterThan(BASE_SIZE);
    const big = computePointSizes(2, new Uint32Array([1, 1e6]));
    expect(big[1]).toBe(MAX_SIZE);
  });
});
