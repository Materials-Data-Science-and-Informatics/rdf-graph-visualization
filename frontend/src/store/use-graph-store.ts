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
import { ApiError, getExpand, getSubgraph } from "../api/client";
import type { SubgraphResponse } from "../api/types";
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
 * the hook and tests share this path.
 */
export async function loadFirstPage(signal?: AbortSignal): Promise<SubgraphResponse> {
  const slice = await getSubgraph({}, { signal });
  graphStore.replaceSlice(slice);
  return slice;
}

/**
 * Expand-on-click core (card C2 DoD): fetch the NEXT cursor page and MERGE
 * it — the store grows without a refetch-all. Returns null (no request made)
 * when the current slice is complete, so callers can fire it unconditionally
 * from a node click.
 */
export async function expandNextPage(signal?: AbortSignal): Promise<MergeResult | null> {
  const cursor = graphStore.nextCursor;
  if (cursor === null) return null;
  const slice = await getSubgraph({ cursor }, { signal });
  return graphStore.ingest(slice, cursor);
}

/**
 * Card C3 (URL restore): load the first page, then keep expanding until the
 * store's next-page cursor equals `targetCursor` — i.e. until the store
 * holds exactly the pages the shared view had when its URL was copied.
 * Returns as soon as the slice runs out (a shrunken dataset degrades to
 * "everything the server has left" instead of looping).
 */
export async function loadToCursor(
  targetCursor: string | null,
  signal?: AbortSignal
): Promise<void> {
  await loadFirstPage(signal);
  if (targetCursor === null) return;
  while (graphStore.nextCursor !== null && graphStore.nextCursor !== targetCursor) {
    await expandNextPage(signal);
  }
}

/** Keep the URL's `cursor` key in step with the store (C3 data-state sync). */
function syncCursorToUrl(): void {
  updateSearchKeys({ cursor: graphStore.nextCursor });
}

/**
 * Search → fly-to core (card E1): make `iri` visible and focus it.
 *
 * - In-slice: pure store mutation (select + focus) — zero network, so the
 *   fly-to trigger (focusSequence bump) lands in the same tick.
 * - Out-of-slice: fetch the entity's /api/expand/{iri} slice (center + 1 hop,
 *   card B2) and merge it with ingestEntity() — WITHOUT cursor bookkeeping,
 *   so the in-flight /api/subgraph continuation survives the jump.
 *
 * Returns the merge result (null when nothing was fetched). Throws when the
 * expand slice does not contain the center (data vanished between search and
 * jump, or a malformed slice) — callers surface the message. A caller-side
 * abort surfaces as the original AbortError, like every other client call.
 *
 * Known TOCTOU (same class as the store's expand-on-click note): a concurrent
 * replaceSlice() (reload) may clear the merged node before select/focus run;
 * both are no-ops for unknown ids, so the jump is skipped, never wrong.
 */
export async function focusEntity(iri: string, signal?: AbortSignal): Promise<MergeResult | null> {
  let merged: MergeResult | null = null;
  if (!graphStore.hasNode(iri)) {
    const slice = await getExpand(iri, { signal });
    merged = graphStore.ingestEntity(slice);
    if (!graphStore.hasNode(iri)) {
      throw new Error(`Entity ${iri} was not present in its expand slice`);
    }
  }
  graphStore.select(iri);
  graphStore.focus(iri);
  return merged;
}

export interface SliceActions {
  /** Initial load / reload in flight (replace, from the first page). */
  loading: boolean;
  /** Cursor-continued expand in flight. */
  expanding: boolean;
  error: string | null;
  /**
   * Load the first page and replace the store (initial load, reload button).
   * With a `targetCursor` (C3 URL restore) keep expanding until the shared
   * view's data state is reached; without one, a plain fresh first page.
   */
  load: (targetCursor?: string | null) => void;
  /** Fetch the next cursor page and merge it; no-op when complete/blocked. */
  expand: () => void;
  clearError: () => void;
}

export function useSliceActions(): SliceActions {
  const [loading, setLoading] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const expandAbortRef = useRef<AbortController | null>(null);
  const expandInFlightRef = useRef(false);

  const load = useCallback((targetCursor: string | null = null) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    void (async () => {
      try {
        await loadToCursor(targetCursor, controller.signal);
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
        await expandNextPage(controller.signal);
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
