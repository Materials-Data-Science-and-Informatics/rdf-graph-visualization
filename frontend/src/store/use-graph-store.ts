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
import type { SubgraphResponse } from "../api/types";
import type { GraphData } from "react-force-graph-3d";
import { GraphStore, type MergeResult } from "./graph-store";

/** App-wide singleton store (card C3 later serializes view state, not data). */
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

export interface SliceActions {
  /** Initial load / reload in flight (replace, from the first page). */
  loading: boolean;
  /** Cursor-continued expand in flight. */
  expanding: boolean;
  error: string | null;
  /** Load the first page and replace the store (initial load, reload button). */
  load: () => void;
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

  const load = useCallback(() => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    void (async () => {
      try {
        await loadFirstPage(controller.signal);
        if (controller.signal.aborted) return;
        setError(null);
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
