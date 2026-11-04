// Card E2 — pure display helpers for the entity detail panel.
//
// The backend serves an entity as ``node`` (frozen Node shape) plus
// ``properties`` (predicate IRI -> literal/object value strings). This module
// turns that raw shape into what the panel renders: readable predicate names,
// a deterministic property order, and a URL-vs-literal decision so IRI values
// (PURLs, DOIs, linked-entity IRIs) can render as links. Pure and
// side-effect-free, so it bundles into the headless test suite as-is.

/**
 * IRI -> local name for display (mirrors the backend's ``_local_name``):
 * everything after the last ``#``, else everything after the last ``/``.
 * A value with neither (already bare) is returned unchanged.
 */
export function localName(iri: string): string {
  const hash = iri.lastIndexOf("#");
  if (hash >= 0) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf("/");
  return iri.slice(slash + 1);
}

/**
 * True when a property value is an http(s) URL — the only scheme a browser
 * can open, so it is the link-or-text decision for rendered values. (IRIs in
 * other schemes, blank nodes ``_:x`` and plain literals stay text.)
 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** One rendered property: the predicate IRI, its display name, its values. */
export interface PropertyRow {
  predicate: string;
  name: string;
  values: string[];
}

/**
 * ``properties`` (predicate IRI -> value[]) -> render rows, ordered by display
 * name (case-insensitive) with the full predicate as a deterministic
 * tiebreaker, so the panel never reorders between renders of the same data.
 */
export function sortProperties(properties: Record<string, string[]>): PropertyRow[] {
  return Object.entries(properties)
    .map(([predicate, values]) => ({ predicate, name: localName(predicate), values }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.predicate.localeCompare(b.predicate));
}
