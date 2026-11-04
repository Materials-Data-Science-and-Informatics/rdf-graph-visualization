// React binding for the graph store (card C2).
//
// One app-wide store instance plus:
//   - useGraphStoreVersion(): re-render trigger (useSyncExternalStore token)
//   - useGraphData():          current store contents as force-graph data
//   - useSliceActions():       load/expand fetch orchestration with abort on
//                              unmount and stale-request cancellation
//
// Expand-on-click: `expand()` fetches the NEXT cursor page only (no cursor
// ever sent after a replace) and merges it, so the store grows without a
// refetch-all.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, getSubgraph } from "../api/client";
import type { NodeType, SubgraphResponse } from "../api/types";
import type { GraphData } from "react-force-graph-3d";
import { updateSearchKeys } from "../view-state";
import { GraphStore, type MergeResult } from "./graph-store";

/** App-wide singleton store (card C3 serializes view state around it, not the data). */
export const graphStore = new GraphStore();

export function useGraphStoreVersion(): number {
  return useSyncExternalStore(graphStore.subscribe, graphStore.getSnapshot, graphStore.getSnapshot);
}

/** Current store contents as force-graph data; re-renders on store changes. */
export function useGraphData(): GraphData {
  const version = useGraphStoreVersion();
  // `version` is the store's change token; the memo recomputes on every bump.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => graphStore.toGraphData(), [version]);
}

function describe(err: unknown): string {
  // ApiError messages are already self-describing (kind, endpoint, status).
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetch the first page (no cursor) and REPLACE the store. Pure, abortable —
 * the hook and tests share this path. `type` (card E4) restricts the slice
 * to one data-model class server-side; null/omitted = all classes.
 */
export async function loadFirstPage(
  type: NodeType | null = null,
  signal?: AbortSignal
): Promise<SubgraphResponse> {
  const slice = await getSubgraph(type ? { type } : {}, { signal });
  graphStore.replaceSlice(slice);
  return slice;
}

/**
 * Expand-on-click core (card C2 DoD): fetch the NEXT cursor page and MERGE
 * it — the store grows without a refetch-all. Returns null (no request made)
 * when the current slice is complete, so callers can fire it unconditionally
 * from a node click. Card E4: the page continues the CURRENT class filter
 * (the cursor and the `type` param travel together, or "Load more" would
 * silently drop the filter from the second page on).
 */
export async function expandNextPage(
  type: NodeType | null = null,
  signal?: AbortSignal
): Promise<MergeResult | null> {
  const cursor = graphStore.nextCursor;
  if (cursor === null) return null;
  const slice = await getSubgraph({ cursor, ...(type ? { type } : {}) }, { signal });
  return graphStore.ingest(slice, cursor);
}

/**
 * Card C3 (URL restore): load the first page, then keep expanding until the
 * store's next-page cursor equals `targetCursor` — i.e. until the store
 * holds exactly the pages the shared view had when its URL was copied.
 * Returns as soon as the slice runs out (a shrunken dataset degrades to
 * "everything the server has left" instead of looping). Card E4: every page of
 * the restore chain carries the class filter.
 */
export async function loadToCursor(
  targetCursor: string | null,
  type: NodeType | null = null,
  signal?: AbortSignal
): Promise<void> {
  await loadFirstPage(type, signal);
  if (targetCursor === null) return;
  while (graphStore.nextCursor !== null && graphStore.nextCursor !== targetCursor) {
    await expandNextPage(type, signal);
  }
}

/** Keep the URL's `cursor` key in step with the store (C3 data-state sync). */
function syncCursorToUrl(): void {
  updateSearchKeys({ cursor: graphStore.nextCursor });
}

export interface SliceActions {
  /** Initial load / reload in flight (replace, from the first page). */
  loading: boolean;
  /** Cursor-continued expand in flight. */
  expanding: boolean;
  error: string | null;
  /**
   * Load the first page and replace the store (initial load, reload button,
   * class-filter change — card E4). With a `targetCursor` (C3 URL restore)
   * keep expanding until the shared view's data state is reached; without
   * one, a plain fresh first page. Carries the class filter: an explicit
   * `type` argument (a filter change and its reload happen in one handler,
   * before the state update has re-rendered) wins, an explicit `null`
   * clears the filter (the "All" chip / "Load slice" reset — the ref still
   * holds the old class during the same handler, so `null` must mean
   * "clear", not "keep current"), and an omitted argument uses the current
   * filter. A fresh load aborts an in-flight expand (its cursor chain is
   * invalidated by the replace).
   */
  load: (targetCursor?: string | null, type?: NodeType | null) => void;
  /** Fetch the next cursor page (with the current class filter) and merge
   *  it; no-op when complete/blocked. */
  expand: () => void;
  clearError: () => void;
}

/**
 * `typeFilter` (card E4): the data-model class the slice is filtered to
 * (null = all). The hook mirrors it into a ref during render — the
 * standard "latest value" pattern — so the stable callbacks always read
 * the current filter; `load` additionally accepts an explicit override
 * for the same-handler filter-change case (see SliceActions.load).
 */
export function useSliceActions(typeFilter: NodeType | null = null): SliceActions {
  const typeFilterRef = useRef<NodeType | null>(typeFilter);
  typeFilterRef.current = typeFilter;
  const [loading, setLoading] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const expandAbortRef = useRef<AbortController | null>(null);
  const expandInFlightRef = useRef(false);

  const load = useCallback((targetCursor: string | null = null, type?: NodeType | null) => {
    // `undefined` (omitted) → the current filter; an explicit `null` →
    // "clear the filter". The two must stay distinguishable: the reset
    // handler calls load(null, null) while typeFilterRef.current still
    // holds the previous class (the setState has not re-rendered yet), so
    // `type ?? ref` would re-query the stale class (E4 review, round 1).
    const effectiveType = type === undefined ? typeFilterRef.current : type;
    // A fresh replace invalidates the current cursor chain: an in-flight
    // expand would merge a page from the OLD slice into the new store.
    if (expandInFlightRef.current) {
      expandAbortRef.current?.abort();
      expandAbortRef.current = null;
      expandInFlightRef.current = false;
      setExpanding(false);
    }
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    void (async () => {
      try {
        await loadToCursor(targetCursor, effectiveType, controller.signal);
        if (controller.signal.aborted) return;
        setError(null);
        syncCursorToUrl();
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describe(err));
      } finally {
        if (loadAbortRef.current === controller) {
          setLoading(false);
        }
      }
    })();
  }, []);

  const expand = useCallback(() => {
    if (graphStore.nextCursor === null || expandInFlightRef.current) return;
    const controller = new AbortController();
    expandAbortRef.current = controller;
    expandInFlightRef.current = true;
    setExpanding(true);
    void (async () => {
      try {
        await expandNextPage(typeFilterRef.current, controller.signal);
        if (controller.signal.aborted) return;
        setError(null);
        syncCursorToUrl();
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describe(err));
      } finally {
        if (expandAbortRef.current === controller) {
          expandAbortRef.current = null;
        }
        expandInFlightRef.current = false;
        setExpanding(false);
      }
    })();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // Abort stale requests on unmount.
  useEffect(
    () => () => {
      loadAbortRef.current?.abort();
      expandAbortRef.current?.abort();
    },
    []
  );

  return useMemo(
    () => ({ loading, expanding, error, load, expand, clearError }),
    [loading, expanding, error, load, expand, clearError]
  );
}
