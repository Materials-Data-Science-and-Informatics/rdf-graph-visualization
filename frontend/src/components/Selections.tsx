import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import * as React from "react";
import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import { GraphData, LinkObject } from "react-force-graph-3d";
import FilterPanel from "./FilterPanel.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";
import type { NodeType } from "../api/types";
import { useGraphData, graphStore, type SliceActions } from "../store/use-graph-store";
import { initialViewState, updateSearchKeys } from "../view-state";

interface SelectionsProps {
  actions: SliceActions;
  setFilteredGraphData: Dispatch<SetStateAction<GraphData>>;
  /** Data-model class the slice is filtered to (null = all; card E4). */
  typeFilter: NodeType | null;
  setTypeFilter: (type: NodeType | null) => void;
}

/**
 * Slice controls (cards C2/E4): loads the first bounded, cursor-paginated
 * slice into the graph store, grows it via cursor-continued "expand"
 * (Load more / click a node) WITHOUT a refetch-all, and offers the class
 * filter panel (card E4) — picking a class RE-QUERIES the slice with
 * `?type=` (a fresh slice, cursor chain reset), it does not hide nodes
 * client-side. Stale requests are aborted on re-fetch and on unmount (see
 * useSliceActions).
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
  // Current store contents (re-renders on every merged slice).
  const graphData = useGraphData();

  // Initial fetch on mount. A URL with a `cursor` + `type` param re-fetches
  // exactly the pages the shared view had (card C3, class filter card E4);
  // a plain URL loads the first page of all classes.
  const { load: loadSlice } = actions;
  useEffect(() => {
    loadSlice(initialViewState.nextCursor);
  }, [loadSlice]);

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
    if (graphData.nodes.length === 0) {
      setFilteredGraphData({ nodes: [], links: [] });
      return;
    }

    let cancelled = false;

    const processFiltering = () => {
      if (cancelled) {
        return;
      }

      // Keep only links whose endpoints are both present in the slice.
      const nodeIds = new Set(graphData.nodes.map((node) => node.id));
      const filteredLinks = graphData.links.filter((link: LinkObject) => {
        const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
        const targetId = typeof link.target === "object" ? link.target?.id : link.target;
        return nodeIds.has(sourceId) && nodeIds.has(targetId);
      });

      let newGraphData: GraphData;
      if (!isChecked) {
        // Remove nodes that have no connections in the current view
        const connectedNodeIds = new Set(
          filteredLinks.flatMap((link) => {
            const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
            const targetId = typeof link.target === "object" ? link.target?.id : link.target;
            return [sourceId, targetId];
          })
        );
        const connectedNodes = graphData.nodes.filter((node) => connectedNodeIds.has(node.id));
        newGraphData = { nodes: connectedNodes, links: filteredLinks };
      } else {
        // Show all nodes with all their links
        newGraphData = { nodes: graphData.nodes, links: filteredLinks };
      }

      // ForceGraph mutates graph objects in place, so pass fresh copies on every UI-driven update.
      const graphSnapshot: GraphData = {
        nodes: newGraphData.nodes.map((node) => ({ ...node })),
        links: newGraphData.links.map((link) => ({
          ...link,
          source: typeof link.source === "object" ? link.source?.id : link.source,
          target: typeof link.target === "object" ? link.target?.id : link.target,
        })),
      };

      setFilteredGraphData(graphSnapshot);
    };

    if (graphData.nodes.length > 500) {
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
  }, [isChecked, graphData, setFilteredGraphData]);

  const page = graphStore.page;

  // First load only: no slice yet, spinner while the first page is fetched.
  if (actions.loading && graphStore.nodeCount === 0) {
    return <LoadingSpinner />;
  }

  return (
    <div className="mx-auto w-full p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Button
            disabled={actions.loading}
            // A fresh load (replace) starts with no class filter.
            onClick={() => {
              setTypeFilter(null);
              loadSlice(null, null);
            }}
          >
            {actions.loading && <Loader2 aria-hidden className="animate-spin" />}
            Load slice
          </Button>
          {graphStore.canExpand && (
            <Button variant="outline" disabled={actions.expanding} onClick={actions.expand}>
              {actions.expanding && <Loader2 aria-hidden className="animate-spin" />}
              Load more
            </Button>
          )}
          <label className="flex items-center gap-2">
            <Checkbox
              checked={isChecked}
              onCheckedChange={(checked) => setIsChecked(checked === true)}
            />
            Add not connected nodes
          </label>
        </div>
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
        <p className="text-sm text-gray-500">
          {page
            ? `${typeFilter ?? "All classes"}: ${graphStore.nodeCount} nodes, ${graphStore.edgeCount} edges in store (limit ${page.limit}${
                page.truncated ? ", truncated — click a node or Load more to expand" : ", complete"
              })`
            : "No slice loaded yet"}
        </p>
      </div>
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
