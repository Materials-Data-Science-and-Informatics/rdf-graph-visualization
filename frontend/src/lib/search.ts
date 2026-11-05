import type { GraphGroupConfig, SearchResult } from "./api";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;
/** Mirrors backend/app/search.py _MAX_QUERY_LEN. */
export const SEARCH_MAX_QUERY_LEN = 200;
export const SEARCH_MAX_RESULTS = 10;

/** Config group of a search hit (group names equal the NodeType names); `null` = unclassified. */
export function groupForResult(
  result: Pick<SearchResult, "type">,
  groups: readonly Pick<GraphGroupConfig, "name" | "color">[]
): { name: string; color: string } | null {
  return groups.find((g) => g.name === result.type) ?? null;
}

/** Next active index for ↑/↓ with wrap-around; `-1` = nothing active yet. */
export function wrapIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (current + delta + length) % length;
}

/** Last IRI segment (after # or /), falling back to the whole IRI plus host for context. */
export function shortIri(iri: string): string {
  const m = /^https?:\/\/([^/]+)\/(.*)$/.exec(iri);
  if (!m) return iri;
  const path = m[2].replace(/\/$/, "");
  return path ? `${m[1]}/${path}` : m[1];
}

/** Trailing-edge debounce with `cancel`. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}
