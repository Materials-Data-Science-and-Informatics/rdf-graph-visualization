import { describe, expect, it } from "vitest";
import { BASE_SIZE, ROOT_SIZE, computePointSizes, hubSize } from "./point-sizes";

describe("point sizes", () => {
  it("grows hubs with community size, capped", () => {
    expect(hubSize(4)).toBeGreaterThan(BASE_SIZE);
    expect(hubSize(100)).toBeGreaterThan(hubSize(10));
    expect(hubSize(1e6)).toBe(20);
  });

  it("makes the root largest and hubs bigger than leaves", () => {
    const edges = new Uint32Array([0, 1, 1, 2, 1, 3]);
    const s = computePointSizes(4, edges, 3, {
      community: new Int32Array([0, 0, 0, 0]),
      hubs: new Int32Array([1]),
      sizes: new Int32Array([4]),
    });
    expect(s[0]).toBe(ROOT_SIZE);
    expect(s[1]).toBeGreaterThan(s[2]);
    expect(s[2]).toBeGreaterThanOrEqual(BASE_SIZE);
    expect(s[2]).toBeLessThan(BASE_SIZE + 2);
  });
});
