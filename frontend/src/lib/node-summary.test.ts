import { describe, expect, it } from "vitest";
import type { NodeRelationView } from "./graph-store";
import { formatRelationRow, sortRelationCounts, summarizeRelations } from "./node-summary";

const rel = (p: string, dir: "out" | "in"): NodeRelationView => ({
  predicateIndex: 0,
  predicateShort: p,
  dir,
  otherIndex: 0,
});

describe("summarizeRelations", () => {
  it("groups by predicate and direction, sorts by count, truncates", () => {
    const rels = [
      ...Array.from({ length: 3 }, () => rel("affiliation", "in")),
      rel("affiliation", "out"),
      rel("member", "out"),
      rel("member", "out"),
    ];
    const s = summarizeRelations(rels, 2);
    expect(s.rows.map(formatRelationRow)).toEqual(["affiliation ← 3", "member → 2"]);
    expect(s.more).toBe(1);
  });
  it("handles empty input", () => {
    expect(summarizeRelations([])).toEqual({ rows: [], more: 0 });
  });
});

describe("sortRelationCounts", () => {
  it("sorts by total descending without mutating", () => {
    const input = [
      { predicate: "a", out: 1, in: 0 },
      { predicate: "b", out: 2, in: 5 },
    ];
    expect(sortRelationCounts(input).map((r) => r.predicate)).toEqual(["b", "a"]);
    expect(input[0].predicate).toBe("a");
  });
});
