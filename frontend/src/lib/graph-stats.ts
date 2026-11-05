import { groupCounts } from "@/lib/sidebar-settings";
import { relationCounts } from "@/lib/relation-colors";
import type { GraphStore } from "@/lib/graph-store";

/** Per-group and per-relation counts of the visible window (first `limit` nodes). */
export function windowStats(store: GraphStore, limit: number) {
  const counts = groupCounts(store.groups, limit, store.groupNames.length);
  const perPred = relationCounts(
    store.edges,
    store.edgePredicate,
    store.edgeCount,
    limit,
    store.predicates.length
  );
  const rel = new Map<string, number>();
  perPred.forEach((n, p) => {
    const iri = store.predicates[p];
    if (n > 0) rel.set(iri, (rel.get(iri) ?? 0) + n);
  });
  return { counts, relCounts: rel };
}

/** Keep the previous array when equal, so React state does not change identity. */
export const keepIfSameCounts = (prev: number[], next: number[]): number[] =>
  prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next;

export const keepIfSameMap = (
  prev: Map<string, number>,
  next: Map<string, number>
): Map<string, number> =>
  prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v) ? prev : next;
