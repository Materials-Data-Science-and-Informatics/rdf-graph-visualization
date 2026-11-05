import type { NodeRelation } from "./api";
import type { NodeRelationView } from "./graph-store";

export interface RelationSummaryRow {
  predicate: string;
  dir: "out" | "in";
  count: number;
}

/** Group a node's relations by (predicate short name, direction), biggest first; keep `max` rows. */
export function summarizeRelations(
  rels: readonly NodeRelationView[],
  max = 6
): { rows: RelationSummaryRow[]; more: number } {
  const m = new Map<string, RelationSummaryRow>();
  for (const r of rels) {
    const key = `${r.dir}\u0000${r.predicateShort}`;
    const row = m.get(key);
    if (row) row.count++;
    else m.set(key, { predicate: r.predicateShort, dir: r.dir, count: 1 });
  }
  const all = [...m.values()].sort(
    (a, b) => b.count - a.count || a.predicate.localeCompare(b.predicate)
  );
  return { rows: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** "affiliation ← 115" (incoming) / "member → 3" (outgoing). */
export function formatRelationRow(r: RelationSummaryRow): string {
  return `${r.predicate} ${r.dir === "in" ? "←" : "→"} ${r.count.toLocaleString("en-US")}`;
}

/** /api/node relation counts, sorted by total (out + in) descending, ties by name. */
export function sortRelationCounts(rels: readonly NodeRelation[]): NodeRelation[] {
  return [...rels].sort(
    (a, b) => b.out + b.in - (a.out + a.in) || a.predicate.localeCompare(b.predicate)
  );
}
