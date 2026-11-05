// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEPTH_DEFAULT,
  DEPTH_KEY,
  clampDepth,
  depthToMaxHops,
  groupCounts,
  loadDepth,
  saveDepth,
} from "./sidebar-settings";

describe("depth", () => {
  beforeEach(() => localStorage.clear());
  it("clamps and rounds", () => {
    expect(clampDepth(0)).toBe(1);
    expect(clampDepth(99)).toBe(8);
    expect(clampDepth(3.4)).toBe(3);
    expect(clampDepth(NaN)).toBe(DEPTH_DEFAULT);
  });
  it("persists and falls back", () => {
    expect(loadDepth()).toBe(DEPTH_DEFAULT);
    saveDepth(3);
    expect(loadDepth()).toBe(3);
    localStorage.setItem(DEPTH_KEY, "junk");
    expect(loadDepth()).toBe(DEPTH_DEFAULT);
  });
  it("omits max_hops for the default", () => {
    expect(depthToMaxHops(6)).toBeUndefined();
    expect(depthToMaxHops(4)).toBe(4);
  });
});

describe("groupCounts", () => {
  it("counts the first N nodes and unclassified", () => {
    const g = Int16Array.from([0, 1, 1, -1, 0, 5]);
    expect(groupCounts(g, 5, 2)).toEqual([2, 2, 1]);
    expect(groupCounts(g, 100, 2)).toEqual([2, 2, 2]);
  });
});
