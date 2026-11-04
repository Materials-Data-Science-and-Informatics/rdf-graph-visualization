// React binding for the overview (aggregate landing) store — card E3.
//
// One app-wide OverviewStore instance wired to the app-wide GraphStore
// (the graph store receives the expanded typed slices), plus
// useOverviewStore(): a re-render trigger (useSyncExternalStore token)
// exposing the store's state and actions. Mirrors use-graph-store.ts.

import { useMemo, useSyncExternalStore } from "react";
import type { AggregateNode, NodeType } from "../api/types";
import type { ClusterGraphData } from "../lib/aggregate-view";
import { graphStore } from "./use-graph-store";
import type { MergeResult } from "./graph-store";
import { OverviewStore, type OverviewStatus, type OverviewView } from "./overview-store";

/** App-wide singleton (expanded typed slices land in the graph store). */
export const overviewStore = new OverviewStore(graphStore);

export interface OverviewActions {
  /** Store change token (stable between bumps; memoization key). */
  version: number;
  status: OverviewStatus;
  /** /api/aggregate fetch failure (null on success/abort). */
  error: string | null;
  /** Cluster list (count-descending). */
  clusters: AggregateNode[];
  /** Cluster ring renderer data, stable ref, null when not on screen. */
  clusterData: ClusterGraphData | null;
  view: OverviewView;
  activeType: NodeType | null;
  /** Type of the last expand() attempt (retry target after a failure). */
  lastExpandType: NodeType | null;
  expanding: boolean;
  /** Typed-slice fetch for expand-on-click failed (null otherwise). */
  expandError: string | null;
  isClusterView: boolean;
  load: (signal?: AbortSignal) => Promise<void>;
  expand: (type: NodeType, signal?: AbortSignal) => Promise<MergeResult | null>;
  collapse: () => void;
  enterSlice: () => void;
}

/** The store's current state + actions as a plain object (fresh per read). */
function readOverviewActions(version: number): OverviewActions {
  return {
    version,
    status: overviewStore.status,
    error: overviewStore.error,
    clusters: overviewStore.clusters,
    clusterData: overviewStore.clusterData,
    view: overviewStore.view,
    activeType: overviewStore.activeType,
    lastExpandType: overviewStore.lastExpandType,
    expanding: overviewStore.expanding,
    expandError: overviewStore.expandError,
    isClusterView: overviewStore.isClusterView,
    load: overviewStore.load,
    expand: overviewStore.expand,
    collapse: overviewStore.collapse,
    enterSlice: overviewStore.enterSlice,
  };
}

export function useOverviewStore(): OverviewActions {
  const version = useSyncExternalStore(
    overviewStore.subscribe,
    overviewStore.getSnapshot,
    overviewStore.getSnapshot
  );
  // `version` is the store's change token; the memo recomputes on every bump.
  return useMemo(() => readOverviewActions(version), [version]);
}
