import { useEffect, useRef } from "react";
import type { StreamEvent } from "./api";
import { BUNDLE_PREFIX, MAX_BUNDLE_WINDOW, detectBundles } from "./bundles";
import type { GraphStore } from "./graph-store";

const UNCLASSIFIED = "Unclassified";
const REBUILD_DEBOUNCE_MS = 300;

/**
 * Replays nodes [0, n) of `source` into the reset `display`; each member group collapses into one
 * node `urn:hkg:bundle:<k>` (at its first member's position) whose edges are de-duplicated.
 */
export function rebuildDisplay(
  source: GraphStore,
  display: GraphStore,
  n: number,
  bundles: number[][]
): void {
  const target = new Int32Array(n); // source index -> display index
  const bundleOf = new Int32Array(n).fill(-1);
  bundles.forEach((m, k) => m.forEach((i) => (bundleOf[i] = k)));
  const ids: string[] = [];
  const bundleNode: number[] = [];
  const events: StreamEvent[] = [];
  const groupName = (g: number) => (g >= 0 ? source.groupNames[g] : null);
  const labels: Record<string, string> = {};
  let run: { id: string; group?: string | null }[] = [];
  let runHop = 0;
  const flush = () => {
    if (run.length) events.push({ type: "nodes", hop: runHop, nodes: run });
    run = [];
  };
  const add = (id: string, hop: number, group: string | null) => {
    if (run.length && hop !== runHop) flush();
    runHop = hop;
    run.push({ id, group });
    ids.push(id);
  };
  for (let i = 0; i < n; i++) {
    const k = bundleOf[i];
    if (k < 0) {
      target[i] = ids.length;
      add(source.nodeIds[i], source.hops[i], groupName(source.groups[i]));
      const label = source.labels[i];
      if (label !== null) labels[source.nodeIds[i]] = label;
    } else if (bundleNode[k] === undefined) {
      const first = bundles[k][0];
      const g = source.groups[first];
      const id = `${BUNDLE_PREFIX}${k}`;
      bundleNode[k] = ids.length;
      target[i] = ids.length;
      add(id, source.hops[first], groupName(g));
      labels[id] = `${bundles[k].length} × ${g >= 0 ? source.groupNames[g] : UNCLASSIFIED}`;
    } else target[i] = bundleNode[k];
  }
  flush();
  const seen = new Set<string>();
  const edges: { s: string; p: string; o: string }[] = [];
  for (let e = 0; e < source.edgeCount; e++) {
    const a = source.edges[2 * e];
    const b = source.edges[2 * e + 1];
    if (a >= n || b >= n) continue;
    const p = source.predicates[source.edgePredicate[e]] ?? "(other)";
    if (bundleOf[a] >= 0 || bundleOf[b] >= 0) {
      if (target[a] === target[b]) continue;
      const key = `${target[a]}\u0000${p}\u0000${target[b]}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    edges.push({ s: ids[target[a]], p, o: ids[target[b]] });
  }
  display.maxNodes = source.maxNodes;
  for (const ev of events) display.apply(ev);
  display.apply({ type: "labels", labels });
  display.apply({ type: "edges", hop: 0, edges });
  bundles.forEach((m, k) =>
    display.setBundle(
      bundleNode[k],
      m.map((i) => source.nodeIds[i])
    )
  );
}

/**
 * Once the stream is done (and when the node window changes afterwards) bundles structurally
 * equivalent nodes of the shown window into the `display` store; otherwise display stays a plain
 * mirror of `source`. `beforeRebuild` runs right before display is reset (capture positions).
 */
export function useDisplayStore(
  source: GraphStore,
  display: GraphStore,
  phase: string,
  nodeLimit: number,
  beforeRebuild: () => void
): void {
  const before = useRef(beforeRebuild);
  useEffect(() => {
    before.current = beforeRebuild;
  });
  // what display currently holds: "mirror" or the key of the bundled window
  const state = useRef<{ gen: number; key: string }>({ gen: -1, key: "mirror" });
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => {
      const n = Math.min(source.nodeCount, nodeLimit);
      const bundles = n <= MAX_BUNDLE_WINDOW ? detectBundles(source, n) : [];
      const st = state.current;
      if (st.gen !== source.generation) state.current = { gen: source.generation, key: "mirror" };
      const key = bundles.length ? `${n}:${source.edgeCount}` : "mirror";
      if (key === state.current.key) return;
      before.current();
      display.reset();
      rebuildDisplay(source, display, bundles.length ? n : source.nodeCount, bundles);
      state.current = { gen: source.generation, key };
    }, REBUILD_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [source, display, phase, nodeLimit]);
}
