import { describe, expect, it } from "vitest";
import {
  BASE_SIZE,
  MAX_RADIUS_MULTIPLIER,
  MAX_SIZE,
  ROOT_SIZE,
  computeDegrees,
  computePointSizes,
  fillRadiusMultipliers,
  radiusMultiplier,
} from "./node-size";

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

  it("maps the curve to a 3D radius multiplier, root above the cap", () => {
    expect(radiusMultiplier(BASE_SIZE)).toBe(1);
    expect(radiusMultiplier(MAX_SIZE)).toBe(MAX_RADIUS_MULTIPLIER);
    // star: node 0 (root, 1 leaf) .. node 1 (hub, 1000 leaves) via CSR offsets
    const offsets = new Uint32Array([0, 1, 1001, 1002]);
    const out = new Float32Array(3);
    fillRadiusMultipliers(out, 3, offsets);
    expect(out[0]).toBeGreaterThan(MAX_RADIUS_MULTIPLIER);
    expect(out[1]).toBe(MAX_RADIUS_MULTIPLIER);
    expect(out[2]).toBeLessThan(out[1]);
  });
});
