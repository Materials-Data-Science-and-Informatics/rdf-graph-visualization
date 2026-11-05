/** Community detection (Louvain) on the shown node window; pure, runs inside the worker. */
import Graph from "graphology";
import louvain from "graphology-communities-louvain";

export const MIN_COMMUNITY = 4;

export interface Communities {
  /** Community per node (0..count-1, largest first), -1 = none (too small or isolated). */
  community: Int32Array;
  /** Highest-degree member of each community. */
  hubs: Int32Array;
  sizes: Int32Array;
}

/** `pairs` = [a0, b0, a1, b1, ...] node indices < n; self loops and duplicate pairs are ignored. */
export function detectCommunities(
  pairs: Uint32Array,
  n: number,
  minSize = MIN_COMMUNITY
): Communities {
  const g = new Graph({ type: "undirected", multi: false });
  for (let i = 0; i < n; i++) g.addNode(i);
  for (let e = 0; e + 1 < pairs.length; e += 2) {
    const a = pairs[e];
    const b = pairs[e + 1];
    if (a !== b && a < n && b < n) g.mergeEdge(a, b);
  }
  const raw = louvain(g);
  const count = new Map<number, number>();
  for (let i = 0; i < n; i++) count.set(raw[i], (count.get(raw[i]) ?? 0) + 1);
  const kept = [...count].filter(([, c]) => c >= minSize).sort((x, y) => y[1] - x[1]);
  const id = new Map(kept.map(([c], k) => [c, k]));
  const community = new Int32Array(n).fill(-1);
  const hubs = new Int32Array(kept.length).fill(-1);
  const sizes = Int32Array.from(kept, ([, c]) => c);
  const hubDegree = new Int32Array(kept.length).fill(-1);
  for (let i = 0; i < n; i++) {
    const k = id.get(raw[i]);
    if (k === undefined) continue;
    community[i] = k;
    const d = g.degree(i);
    if (d > hubDegree[k]) {
      hubDegree[k] = d;
      hubs[k] = i;
    }
  }
  return { community, hubs, sizes };
}
