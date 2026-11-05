import type { GraphStore } from "./graph-store";

/** A group of at least this many structurally equivalent nodes is shown as one bundle node. */
export const MIN_BUNDLE = 5;
/** Windows above this many nodes are never scanned (big graphs keep their nodes). */
export const MAX_BUNDLE_WINDOW = 20000;
export const BUNDLE_PREFIX = "urn:hkg:bundle:";
/**
 * Members must share at least this many distinct neighbours: plain leaf siblings (one shared
 * hub) stay separate — the layouts already arrange those well (2D leaf discs).
 */
export const MIN_SHARED_NEIGHBOURS = 2;

export const isBundleId = (id: string | undefined): boolean => !!id?.startsWith(BUNDLE_PREFIX);

type BundleInput = Pick<GraphStore, "edges" | "edgeCount" | "edgePredicate" | "groups">;

/**
 * Members (ascending indices) of every bundle in nodes [0, n): nodes with the same class and the
 * same set of (neighbour, predicate, direction), with at least MIN_SHARED_NEIGHBOURS distinct
 * neighbours. The root (0) and edgeless nodes never bundle.
 */
export function detectBundles(store: BundleInput, n: number, min = MIN_BUNDLE): number[][] {
  const keys: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < store.edgeCount; e++) {
    const s = store.edges[2 * e];
    const o = store.edges[2 * e + 1];
    if (s >= n || o >= n) continue;
    const p = store.edgePredicate[e];
    keys[s].push((o * 65536 + p) * 2); // out
    keys[o].push((s * 65536 + p) * 2 + 1); // in
  }
  const bySignature = new Map<string, number[]>();
  for (let i = 1; i < n; i++) {
    const k = keys[i];
    if (k.length === 0) continue;
    k.sort((a, b) => a - b);
    const neighbours = new Set(k.map((v) => Math.floor(v / 131072)));
    if (neighbours.size < MIN_SHARED_NEIGHBOURS) continue;
    const sig = `${store.groups[i]}|${k.filter((v, j) => j === 0 || v !== k[j - 1]).join(",")}`;
    const list = bySignature.get(sig);
    if (list) list.push(i);
    else bySignature.set(sig, [i]);
  }
  return [...bySignature.values()].filter((m) => m.length >= min).sort((a, b) => a[0] - b[0]);
}
