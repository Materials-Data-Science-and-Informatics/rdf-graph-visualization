import { describe, expect, it } from "vitest";
import { communityRegions, fittingUnit, moveIntoRegions } from "./community-layout";

describe("community regions", () => {
  it("gives each community its own, non-overlapping area (largest in the middle)", () => {
    const { centers, radii } = communityRegions([400, 120, 60, 30, 8], 0, 6, 1.25);
    expect(Math.hypot(centers[0], centers[1])).toBe(0);
    for (let a = 0; a < radii.length; a++)
      for (let b = a + 1; b < radii.length; b++) {
        const d = Math.hypot(
          centers[2 * a] - centers[2 * b],
          centers[2 * a + 1] - centers[2 * b + 1]
        );
        expect(d).toBeGreaterThan(Math.max(radii[a], radii[b]));
      }
  });

  it("moves members into their region and leaves others alone", () => {
    const pos = Float32Array.from([0, 0, 10, 0, 500, 500]);
    moveIntoRegions(pos, Int32Array.from([0, 0, -1]), {
      centers: Float32Array.from([100, 100]),
      radii: Float32Array.from([50]),
    });
    expect([pos[0], pos[1], pos[2], pos[3]]).toEqual([95, 100, 105, 100]);
    expect([pos[4], pos[5]]).toEqual([500, 500]);
  });

  it("shrinks the regions of big graphs to fit the layout space", () => {
    const small = [400, 120, 60];
    expect(fittingUnit(small, 6, 1700, 1.25)).toBe(6);
    const big = Array.from({ length: 300 }, (_, i) => Math.max(5, 3000 - i * 10));
    const unit = fittingUnit(big, 6, 1700, 1.25);
    expect(unit).toBeLessThan(6);
    const { centers, radii } = communityRegions(big, 0, unit, 1.25);
    let maxR = 0;
    for (let c = 0; c < radii.length; c++)
      maxR = Math.max(maxR, Math.hypot(centers[2 * c], centers[2 * c + 1]) + radii[c]);
    expect(maxR).toBeLessThanOrEqual(1700 * 1.05);
  });
});
