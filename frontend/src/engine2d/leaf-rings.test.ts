import { describe, expect, it } from "vitest";
import { findLeafGroups, placeLeafDiscs } from "./leaf-rings";

describe("leaf discs", () => {
  // hub 0 with leaves 1..4, hub 0 - node 5 - node 6 chain (5 has degree 2, 6 is a leaf of 5)
  const edges = Uint32Array.from([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 5, 6]);
  const deg = Uint32Array.from([5, 1, 1, 1, 1, 2, 1]);

  it("groups degree-1 nodes under their hub, skipping small stars", () => {
    const g = findLeafGroups(7, edges, 6, deg, 3);
    expect(Array.from(g.hubs)).toEqual([0]);
    expect(Array.from(g.leaves)).toEqual([1, 2, 3, 4]);
  });

  it("puts leaves all around the hub, centred on it", () => {
    const g = findLeafGroups(7, edges, 6, deg, 3);
    const pos = new Float32Array(14);
    pos[0] = 100;
    pos[1] = -50;
    placeLeafDiscs(pos, g, new Float32Array(7).fill(4));
    let cx = 0;
    let cy = 0;
    for (const i of g.leaves) {
      cx += pos[2 * i] - 100;
      cy += pos[2 * i + 1] + 50;
    }
    // leaves spread around the hub: their mean offset is small compared to the disc radius
    expect(Math.hypot(cx / 4, cy / 4)).toBeLessThan(6);
  });
});
