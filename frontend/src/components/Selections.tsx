import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import * as React from "react";
import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import FilterPanel from "./FilterPanel.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";
import type { NodeType } from "../api/types";
import { useGraphData, graphStore, type SliceActions } from "../store/use-graph-store";
import type { RendererGraph } from "../render";
import { useOverviewStore, overviewStore } from "../store/use-overview-store";
import { pickLandingMode } from "../lib/aggregate-view";
import { initialViewState, updateSearchKeys } from "../view-state";

interface SelectionsProps {
  actions: SliceActions;
  setFilteredGraphData: Dispatch<SetStateAction<RendererGraph>>;
  /** Data-model class the slice is filtered to (null = all; card E4). */
  typeFilter: NodeType | null;
  setTypeFilter: (type: NodeType | null) => void;
}

/**
 * Slice + overview controls (cards C2/E3): loads the first bounded,
 * cursor-paginated slice into the graph store, and grows it further via
 * cursor-continued "expand" (Load more / click a node) WITHOUT a refetch-all.
 * Stale requests are aborted on re-fetch and on unmount (see useSliceActions).
 *
 * Card E3 adds the aggregate layer on top: the cluster ring (one typed node
 * per data-model class, from /api/aggregate) and the layer switch —
 * Show/Back-to-overview, Refresh, Explore slice. Expand-on-click lives in
 * Content.tsx (node click) and fetches the typed slice into the graph store.
 *
 * Card E4 adds the class filter: picking a class RE-QUERIES the slice with
 * `?type=` (a fresh slice, cursor chain reset) — it does not hide nodes
 * client-side.
 */
const Selections: React.FC<SelectionsProps> = ({
  actions,
  setFilteredGraphData,
  typeFilter,
  setTypeFilter,
}) => {
  // Card C3: initial view state is read from the opened URL (one-time
  // capture); every change below writes its keys back (replaceState).
  const [isChecked, setIsChecked] = useState<boolean>(initialViewState.showIsolated);
  // Legend group filters (client-side, current view only; the class filter
  // is server-side — card E4).
  const [filters, setFilters] = useState<Set<string>>(() => new Set(initialViewState.hiddenGroups));
  // Current store contents (re-renders on every merged slice).
  const sliceData = useGraphData();
  // Card E3: the cluster ring is on screen whenever the overview store says
  // so (stable reference — see OverviewStore.clusterData).
  const overview = useOverviewStore();
  const data = overview.clusterData ?? sliceData;

  // Card E3 S3: the first paint IS the aggregate overview (landing). URL
  // deep links take precedence: `ov=<type>` restores a shared expanded
  // cluster (typed first page + cursor pages up to the shared cursor); a
  // plain `cursor`/`sel` restore the legacy C3 slice view without loading
  // the overview. A `type` param carries the class filter (card E4).
  // Stale restores are aborted on unmount.
  const { load: loadSlice } = actions;
  const landing = pickLandingMode(initialViewState);
  useEffect(() => {
    if (landing === "slice-restore") {
      loadSlice(initialViewState.nextCursor);
      return;
    }
    const controller = new AbortController();
    // NOTE: read state off the store singleton, not the `overview` snapshot
    // captured by this closure — the snapshot is frozen at the mount render
    // and would still hold the pre-load (empty) cluster list here.
    void (async () => {
      await overviewStore.load(controller.signal);
      if (controller.signal.aborted) return;
      if (landing !== "ov-restore" || !initialViewState.ov) return;
      const wanted = initialViewState.ov;
      // A shrunken dataset may no longer carry the class: stay on the
      // overview instead of erroring.
      if (!overviewStore.clusters.some((c) => c.type === wanted)) return;
      // Cluster ids come from validated /api/aggregate rows (B4 contract:
      // types pinned to the NodeType union); the URL value is a string.
      await overviewStore.restoreExpanded(
        wanted as NodeType,
        initialViewState.nextCursor,
        controller.signal
      );
    })();
    return () => controller.abort();
  }, [landing, loadSlice]);

  // Card E3 S3: keep the URL's `ov` key in step with the expanded cluster
  // (present only while a cluster's typed slice is the active view).
  useEffect(() => {
    updateSearchKeys({
      ov: overview.view === "slice" && overview.activeType ? overview.activeType : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.version]);

  // Card C3: keep the URL's class-filter key in step with the state.
  useEffect(() => {
    updateSearchKeys({ type: typeFilter });
  }, [typeFilter]);
  useEffect(() => {
    updateSearchKeys({ iso: isChecked ? "1" : null });
  }, [isChecked]);

  // "Add not connected nodes" (C2/C3 display option): when off, drop nodes
  // without a connection in the current slice. The class filter itself is
  // server-side (card E4) — nothing is hidden here any more.
  useEffect(() => {
    if (data.nodes.length === 0) {
      setFilteredGraphData({ nodes: [], links: [] });
      return;
    }

    let cancelled = false;

    const processFiltering = () => {
      if (cancelled) {
        return;
      }

      // Filter nodes by selected groups; if no filters, show all nodes
      const filteredNodes =
        filters.size === 0
          ? data.nodes
          : data.nodes.filter((node) => {
              const tempFilters = new Set(filters);
              if (filters.has("Default")) {
                tempFilters.delete("Default");
                tempFilters.add("");
              }
              return !tempFilters.has(node.group ?? "");
            });

      // Create a Set of node IDs for O(1) lookup
      const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));

      // Filter links to only include those connecting filtered nodes
      // (contract RendererLink: source/target are always id strings).
      const filteredLinks = data.links.filter((link) => {
        return filteredNodeIds.has(link.source) && filteredNodeIds.has(link.target);
      });

      let newGraphData: RendererGraph;
      if (!isChecked) {
        // Remove nodes that have no connections in the current view
        const connectedNodeIds = new Set(
          filteredLinks.flatMap((link) => [link.source, link.target])
        );
        const connectedNodes = data.nodes.filter((node) => connectedNodeIds.has(node.id));
        newGraphData = { nodes: connectedNodes, links: filteredLinks };
      } else {
        // Show all nodes with all their links
        newGraphData = { nodes: data.nodes, links: filteredLinks };
      }

      // The mounted renderer OWNS the objects it is handed and may mutate
      // them in place (CONTRACT.md §1.2), so pass fresh copies on every
      // UI-driven update.
      const graphSnapshot: RendererGraph = {
        nodes: newGraphData.nodes.map((node) => ({ ...node })),
        links: newGraphData.links.map((link) => ({ ...link })),
      };

      setFilteredGraphData(graphSnapshot);
    };

    if (data.nodes.length > 500) {
      const timeout = window.setTimeout(processFiltering, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
      };
    }

    processFiltering();

    return () => {
      cancelled = true;
    };
  }, [isChecked, filters, data, setFilteredGraphData]);

  const page = graphStore.page;
  const inClusters = overview.isClusterView;
  const expandedType = overview.activeType;
  const lastExpandType = overview.lastExpandType;

  // First load only: no slice yet, spinner while the first page is fetched.
  // Card E3: also while the cluster layer is loading with nothing on screen
  // (view "clusters" — isClusterView would require status "ready").
  if (actions.loading && graphStore.nodeCount === 0) {
    return <LoadingSpinner />;
  }
  if (overview.view === "clusters" && overview.status === "loading" && graphStore.nodeCount === 0) {
    return <LoadingSpinner />;
  }

  return (
    <div className="mx-auto w-full p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          {inClusters ? (
            <>
              <Button
                disabled={overview.status === "loading"}
                onClick={() => {
                  void overview.load();
                }}
              >
                {overview.status === "loading" && <Loader2 aria-hidden className="animate-spin" />}
                Refresh overview
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  overview.enterSlice();
                  if (graphStore.nodeCount === 0) {
                    setFilters(new Set<string>());
                    actions.load();
                  }
                }}
              >
                Explore slice
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={actions.loading}
                // A fresh load (replace) starts with no class filter and no
                // active group filters; it is a PLAIN slice, so any expanded
                // cluster is cleared (E3) and the cursor chain resets (E4).
                onClick={() => {
                  setFilters(new Set<string>());
                  setTypeFilter(null);
                  overview.enterSlice();
                  actions.load(null, null);
                }}
              >
                {actions.loading && <Loader2 aria-hidden className="animate-spin" />}
                Load slice
              </Button>
              {overview.status === "ready" && (
                <Button variant="outline" onClick={overview.collapse}>
                  Back to overview
                </Button>
              )}
              {overview.status !== "ready" && (
                <Button variant="outline" onClick={() => void overview.load()}>
                  {overview.status === "loading" ? (
                    <Loader2 aria-hidden className="animate-spin" />
                  ) : (
                    "Show overview"
                  )}
                </Button>
              )}
            </>
          )}
          {!inClusters && graphStore.canExpand && (
            <Button variant="outline" disabled={actions.expanding} onClick={actions.expand}>
              {actions.expanding && <Loader2 aria-hidden className="animate-spin" />}
              Load more
            </Button>
          )}
          {!inClusters && (
            <label className="flex items-center gap-2">
              <Checkbox
                checked={isChecked}
                onCheckedChange={(checked) => setIsChecked(checked === true)}
              />
              Add not connected nodes
            </label>
          )}
        </div>
        {!inClusters && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Filter by class</span>
            <FilterPanel
              value={typeFilter}
              disabled={actions.loading}
              onChange={(group) => {
                setTypeFilter(group);
                // Card E4 DoD: a filter change re-queries the slice — a fresh
                // load with the new class (cursor chain resets). The explicit
                // `group` argument is the not-yet-rendered state (same handler).
                loadSlice(null, group);
              }}
            />
          </div>
        )}
        <p className="text-sm text-gray-500">
          {inClusters
            ? `${overview.clusters.length} classes · counts from /api/aggregate — click a cluster to expand its type`
            : page
              ? `${typeFilter ?? "All classes"}: ${graphStore.nodeCount} nodes, ${graphStore.edgeCount} edges in store${
                  expandedType ? ` (type: ${expandedType})` : ""
                } (limit ${page.limit}${
                  page.truncated
                    ? ", truncated — click a node or Load more to expand"
                    : ", complete"
                })`
              : "No slice loaded yet"}
        </p>
      </div>
      {overview.error && (
        <div
          role="alert"
          className="mx-auto mt-3 mb-3 flex w-full items-start gap-3 rounded-[6px] border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
        >
          <AlertCircle
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
          />
          <div>
            <span className="font-bold">Could not load the overview</span>
            <span className="mt-1 block text-sm" data-testid="overview-error">
              {overview.error}
            </span>
          </div>
        </div>
      )}
      {overview.expandError && (
        <div
          role="alert"
          className="mx-auto mt-3 mb-3 flex w-full items-start gap-3 rounded-[6px] border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
        >
          <AlertCircle
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
          />
          <div className="flex-1">
            <span className="font-bold">Could not expand {lastExpandType}</span>
            <span className="mt-1 block text-sm" data-testid="overview-expand-error">
              {overview.expandError}
            </span>
          </div>
          {lastExpandType && (
            <Button variant="outline" onClick={() => void overview.expand(lastExpandType)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {actions.error && (
        <div
          role="alert"
          className="mx-auto mt-3 mb-3 flex w-full items-start gap-3 rounded-[6px] border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
        >
          <AlertCircle
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
          />
          <div>
            <span className="font-bold">Could not load graph slice</span>
            <span className="mt-1 block text-sm" data-testid="slice-error">
              {actions.error}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default Selections;
