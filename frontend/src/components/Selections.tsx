import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import * as React from "react";
import { useState, useEffect, type Dispatch, type SetStateAction } from "react";
import { GraphData, LinkObject } from "react-force-graph-3d";
import LoadingSpinner from "./LoadingSpinner.tsx";
import { useGraphData, graphStore, type SliceActions } from "../store/use-graph-store";
import { initialViewState, updateSearchKeys } from "../view-state";

interface SelectionsProps {
  actions: SliceActions;
  setFilteredGraphData: Dispatch<SetStateAction<GraphData>>;
}

/**
 * Slice controls (card C2): loads the first bounded, cursor-paginated slice
 * into the graph store, and grows it further via cursor-continued "expand"
 * (Load more / click a node) WITHOUT a refetch-all. Stale requests are
 * aborted on re-fetch and on unmount (see useSliceActions).
 */
const Selections: React.FC<SelectionsProps> = ({ actions, setFilteredGraphData }) => {
  // Card C3: initial view state is read from the opened URL (one-time
  // capture); every change below writes its keys back (replaceState).
  const [isChecked, setIsChecked] = useState<boolean>(initialViewState.showIsolated);
  const [filters, setFilters] = useState<Set<string>>(() => new Set(initialViewState.hiddenGroups));
  // Current store contents (re-renders on every merged slice).
  const graphData = useGraphData();

  // Initial fetch on mount. A URL with a `cursor` param re-fetches exactly
  // the pages the shared view had (card C3); a plain URL loads the first
  // page only.
  const { load: loadSlice } = actions;
  useEffect(() => {
    loadSlice(initialViewState.nextCursor);
  }, [loadSlice]);

  // Card C3: keep the URL's filter keys in step with the state. (A fresh
  // load via the "Load slice" button below clears the group filters — the
  // previous load-completion effect is gone so a restored filter survives
  // the initial load.)
  useEffect(() => {
    updateSearchKeys({ hide: filters.size > 0 ? [...filters].join(",") : null });
  }, [filters]);
  useEffect(() => {
    updateSearchKeys({ iso: isChecked ? "1" : null });
  }, [isChecked]);

  // Filter graph data based on selected groups and optionally remove unconnected nodes
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

      // Filter nodes by selected groups; if no filters, show all nodes
      const filteredNodes =
        filters.size === 0
          ? graphData.nodes
          : graphData.nodes.filter((node) => {
              const tempFilters = new Set(filters);
              if (filters.has("Default")) {
                tempFilters.delete("Default");
                tempFilters.add("");
              }
              return !tempFilters.has(node.group);
            });

      // Create a Set of node IDs for O(1) lookup
      const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));

      // Filter links to only include those connecting filtered nodes
      const filteredLinks = graphData.links.filter((link: LinkObject) => {
        const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
        const targetId = typeof link.target === "object" ? link.target?.id : link.target;
        return filteredNodeIds.has(sourceId) && filteredNodeIds.has(targetId);
      });

      let newGraphData: GraphData;
      if (!isChecked) {
        // Remove nodes that have no connections in the filtered view
        const connectedNodeIds = new Set(
          filteredLinks.flatMap((link) => {
            const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
            const targetId = typeof link.target === "object" ? link.target?.id : link.target;
            return [sourceId, targetId];
          })
        );
        const connectedNodes = filteredNodes.filter((node) => connectedNodeIds.has(node.id));
        newGraphData = { nodes: connectedNodes, links: filteredLinks };
      } else {
        // Show all filtered nodes with all their links
        newGraphData = { nodes: filteredNodes, links: filteredLinks };
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
  }, [isChecked, filters, graphData, setFilteredGraphData]);

  const page = graphStore.page;

  // First load only: no slice yet, spinner while the first page is fetched.
  if (actions.loading && graphStore.nodeCount === 0) {
    return <LoadingSpinner />;
  }

  return (
    <div className="mx-auto w-full p-4">
      <div className="flex flex-wrap items-center gap-4">
        <Button
          disabled={actions.loading}
          // A fresh load (replace) starts with no active group filters.
          onClick={() => {
            setFilters(new Set<string>());
            actions.load();
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
        <p className="mt-2 text-sm text-gray-500">
          {page
            ? `${graphStore.nodeCount} nodes, ${graphStore.edgeCount} edges in store (limit ${page.limit}${
                page.truncated ? ", truncated — click a node or Load more to expand" : ", complete"
              })`
            : "No slice loaded yet"}
        </p>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={isChecked}
            onCheckedChange={(checked) => setIsChecked(checked === true)}
          />
          Add not connected nodes
        </label>
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
