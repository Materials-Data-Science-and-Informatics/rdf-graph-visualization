import { describe, expect, it } from "vitest";
import { relationCounts, relationPalette } from "./relation-colors";

describe("relation colours", () => {
  it("gives each configured relation its own stable colour", () => {
    const p = relationPalette(["a", "b", "c"]);
    expect(new Set(p.values()).size).toBe(3);
    expect(relationPalette(["a", "x"]).get("a")).toBe(p.get("a"));
  });
  it("counts only edges inside the node window", () => {
    const edges = Uint32Array.from([0, 1, 1, 2, 0, 5]);
    const preds = Uint16Array.from([0, 1, 1]);
    expect(relationCounts(edges, preds, 3, 3, 2)).toEqual([1, 1]);
    expect(relationCounts(edges, preds, 3, 10, 2)).toEqual([1, 2]);
  });
});
