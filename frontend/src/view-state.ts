// Card C3 — URL-synced view state.
//
// The "view" is everything that distinguishes one screen from another,
// EXCEPT node positions (renderer-owned, contract D1 §P1/§V1):
//
//   cam    camera position            "x,y,z" (3 decimals)
//   look   camera orbit target        "x,y,z" (3 decimals)
//   sel    selected node IRI
//   hide   excluded groups            "Person,Document" ("" = show all)
//   iso    "add not connected nodes"  "1"
//   theme  "light"                    (dark is the default, omitted)
//   cursor next-page cursor of the slice as shared (data state: which
//          cursor pages were already ingested; null = first page only)
//
// A pasted URL therefore reproduces: the same data (pages re-fetched up to
// the shared cursor), the same filtering, the same selection, the same
// theme and the same camera. Layout re-runs on load, so node positions are
// not part of the view state (they are renderer-owned and would also drift
// while the force simulation settles).
//
// Pure module: no React, no DOM side effects except updateSearchKeys()
// (guarded for non-browser environments), so it bundles into tests as-is.

export interface ViewVec3 {
  x: number;
  y: number;
  z: number;
}

export interface ViewState {
  /** Camera position at share time (null = no saved camera). */
  camera: ViewVec3 | null;
  /** Camera orbit target at share time (null = engine default, origin). */
  look: ViewVec3 | null;
  /** Selected node IRI (null = nothing selected). */
  selectedId: string | null;
  /** Group names excluded by the group filter (empty = show all). */
  hiddenGroups: string[];
  /** "Add not connected nodes" checkbox. */
  showIsolated: boolean;
  theme: "dark" | "light";
  /**
   * Token of the slice page that was still pending when the view was
   * shared — i.e. the store's `nextCursor` at that moment (null = the
   * first page only, or the slice was already complete).
   */
  nextCursor: string | null;
}

export const DEFAULT_VIEW_STATE: ViewState = {
  camera: null,
  look: null,
  selectedId: null,
  hiddenGroups: [],
  showIsolated: false,
  theme: "dark",
  nextCursor: null,
};

// ----------------------------------------------------------------- parsing

function parseVec3(raw: string | null): ViewVec3 | null {
  if (!raw) return null;
  const parts = raw.split(",");
  if (parts.length !== 3) return null;
  const [x, y, z] = parts.map((p) => Number.parseFloat(p.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/**
 * Parse a view state from a search string ("?a=b" or "a=b"). Tolerant by
 * design: unknown parameters are ignored, malformed values fall back to
 * defaults, so a half-broken pasted URL degrades to "default view" instead
 * of crashing the app.
 */
export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search);
  const theme = p.get("theme");
  return {
    camera: parseVec3(p.get("cam")),
    look: parseVec3(p.get("look")),
    selectedId: p.get("sel") || null,
    hiddenGroups: (p.get("hide") ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    showIsolated: p.get("iso") === "1",
    theme: theme === "light" ? "light" : "dark",
    nextCursor: p.get("cursor") || null,
  };
}

// -------------------------------------------------------------- serialising

function formatVec3(v: ViewVec3): string {
  return `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
}

/** Serialize a view state to a search string (defaults omitted, no leading "?"). */
export function toSearch(state: ViewState): string {
  const p = new URLSearchParams();
  if (state.camera) p.set("cam", formatVec3(state.camera));
  if (state.look) p.set("look", formatVec3(state.look));
  if (state.selectedId) p.set("sel", state.selectedId);
  if (state.hiddenGroups.length > 0) p.set("hide", state.hiddenGroups.join(","));
  if (state.showIsolated) p.set("iso", "1");
  if (state.theme === "light") p.set("theme", "light");
  if (state.nextCursor) p.set("cursor", state.nextCursor);
  return p.toString();
}

// -------------------------------------------------------------- url wiring

/**
 * Read-modify-write the current URL's query string: set the given keys
 * (or delete them when the value is null/empty), preserving every other
 * parameter. Uses history.replaceState — no history entry, no navigation.
 * No-op when nothing changed or outside a browser.
 */
export function updateSearchKeys(updates: Record<string, string | null>): void {
  if (typeof window === "undefined" || !window.history || !window.location) return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    } else if (url.searchParams.get(key) !== value) {
      url.searchParams.set(key, value);
      changed = true;
    }
  }
  if (!changed) return;
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * View state captured ONCE at module load, from the URL the user opened.
 * Everything written afterwards by the app (replaceState) must not feed
 * back into this — hence the one-time capture, and parseViewState() for
 * anything that needs the current URL.
 */
export const initialViewState: ViewState = parseViewState(
  typeof window === "undefined" ? "" : window.location.search
);
