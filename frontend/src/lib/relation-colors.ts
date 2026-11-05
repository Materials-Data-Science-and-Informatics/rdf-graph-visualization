/**
 * Relation (predicate) colours: one distinct hue per configured relation, in config
 * order (golden-angle hue steps), so a relation keeps its colour across roots.
 */
const GOLDEN_ANGLE = 137.508;

export function relationPalette(relationIris: readonly string[]): Map<string, string> {
  return new Map(
    relationIris.map((iri, i) => {
      const hue = Math.round((i * GOLDEN_ANGLE + 200) % 360);
      const light = i % 2 ? 62 : 52; // alternate lightness so neighbouring hues differ more
      return [iri, `hsl(${hue}, 70%, ${light}%)`];
    })
  );
}

/**
 * Shown edges per store predicate index: edges whose endpoints are both < `shown`
 * (the node window). Result length = `predicateCount`.
 */
export function relationCounts(
  edges: Uint32Array,
  edgePredicate: Uint16Array,
  edgeCount: number,
  shown: number,
  predicateCount: number
): number[] {
  const out = new Array<number>(predicateCount).fill(0);
  for (let e = 0; e < edgeCount; e++) {
    if (edges[2 * e] < shown && edges[2 * e + 1] < shown) {
      const p = edgePredicate[e];
      if (p < predicateCount) out[p]++;
    }
  }
  return out;
}
