import { describe, expect, it } from "vitest";
import { detectCommunities } from "./communities";

describe("detectCommunities", () => {
  it("splits two cliques joined by one edge and picks the best connected hubs", () => {
    const pairs: number[] = [];
    for (const base of [0, 5])
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) pairs.push(base + i, base + j);
    pairs.push(4, 5, 0, 0, 1, 0); // bridge, self loop, duplicate (reversed) pair
    pairs.push(0, 10); // node 10 hangs off node 0 (hub of the first clique)
    const r = detectCommunities(new Uint32Array(pairs), 11);
    expect(r.sizes.length).toBe(2);
    expect(new Set(r.community.slice(0, 5)).size).toBe(1);
    expect(new Set(r.community.slice(5, 10)).size).toBe(1);
    expect(r.community[0]).not.toBe(r.community[5]);
    expect(r.hubs[r.community[0]]).toBe(0);
  });

  it("drops communities below the minimum size", () => {
    const r = detectCommunities(new Uint32Array([0, 1, 1, 2]), 4);
    expect([...r.community]).toEqual([-1, -1, -1, -1]);
    expect(r.hubs.length).toBe(0);
  });
});
