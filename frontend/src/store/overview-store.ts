// Card E3 — Overview (aggregate landing) store: pure observable, no React.
//
// Owns the cluster landing state machine:
//
//   idle → load() → ready ──expand(type)──▶ "slice" view (typed slice now
//                   ▲        │                   lives in the graph store)
//                   │        └──collapse()──▶ "clusters" view (back to the
//                   └────────enterSlice()────▶ "slice" view (plain load)
//
// "expand" is the card's expand-on-click: fetch the typed /api/subgraph
// first page (query `type`) and REPLACE the graph store with it, so the
// existing slice pipeline (cursor "Load more", filters, selection, URL
// cursor sync) then runs unchanged. A failed or aborted expand leaves the
// graph store untouched.
//
// The store is a plain observable class (subscribe/getSnapshot) in the same
// shape as GraphStore; the React binding lives in use-overview-store.ts.
// The client (aggregate/subgraph fetchers) is injectable so headless tests
// run without a network.

import type { AggregateNode, NodeType, AggregateResponse, SubgraphResponse } from "../api/types";
import { getAggregate, getSubgraph } from "../api/client";
import type { GraphStore, MergeResult } from "./graph-store";
import { validateAggregate } from "../lib/aggregate-view";

/** Injectable fetch seam (defaults to the typed API client). */
export interface OverviewClient {
  aggregate: (options?: { signal?: AbortSignal }) => Promise<AggregateResponse>;
  subgraph: (
    query: { type?: NodeType; limit?: number; cursor?: string | null },
    options?: { signal?: AbortSignal }
  ) => Promise<SubgraphResponse>;
}

const defaultClient: OverviewClient = { aggregate: getAggregate, subgraph: getSubgraph };

export type OverviewStatus = "idle" | "loading" | "ready" | "error";
/** Which layer is on screen: the cluster ring or the typed entity slice. */
export type OverviewView = "clusters" | "slice";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class OverviewStore {
  private readonly graph: GraphStore;
  private readonly client: OverviewClient;

  private version = 0;
  private readonly listeners: Set<() => void> = new Set();

  private statusValue: OverviewStatus = "idle";
  private errorValue: string | null = null;
  private clustersValue: AggregateNode[] = [];
  private viewValue: OverviewView = "clusters";
  private activeTypeValue: NodeType | null = null;
  private expandingValue = false;
  private expandErrorValue: string | null = null;
  /** Load sequence token; a superseded load never writes state. */
  private loadSeq = 0;

  constructor(graph: GraphStore, client: OverviewClient = defaultClient) {
    this.graph = graph;
    this.client = client;
  }

  // ---------------------------------------------------------------- observers

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Snapshot token for useSyncExternalStore (a number is stable enough). */
  getSnapshot = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------- state

  get status(): OverviewStatus {
    return this.statusValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  /** Cached aggregate rows (count-descending), fresh copy per read. */
  get clusters(): AggregateNode[] {
    return [...this.clustersValue];
  }

  get view(): OverviewView {
    return this.viewValue;
  }

  /** The expanded cluster's type (null = no cluster expanded). */
  get activeType(): NodeType | null {
    return this.activeTypeValue;
  }

  /** A typed-slice fetch for expand-on-click is in flight. */
  get expanding(): boolean {
    return this.expandingValue;
  }

  get expandError(): string | null {
    return this.expandErrorValue;
  }

  /** The cluster ring is on screen. */
  get isClusterView(): boolean {
    return this.statusValue === "ready" && this.viewValue === "clusters";
  }

  // ------------------------------------------------------------------ actions

  /**
   * Fetch /api/aggregate and cache the clusters (initial landing load,
   * refresh, retry). Safe to re-call; an in-flight load supersedes any
   * earlier one.
   */
  async load(signal?: AbortSignal): Promise<void> {
    const seq = ++this.loadSeq;
    this.clustersValue = [];
    this.errorValue = null;
    this.statusValue = "loading";
    this.emit();
    try {
      const response = await this.client.aggregate({ signal });
      if (seq !== this.loadSeq) return; // superseded by a newer load
      this.clustersValue = validateAggregate(response);
      this.statusValue = "ready";
      this.emit();
    } catch (err) {
      if (seq !== this.loadSeq) return; // superseded — the newer load owns state
      if (signal?.aborted) {
        // Caller cancel: no error; fall back to whatever is still cached.
        this.statusValue = this.clustersValue.length > 0 ? "ready" : "idle";
        this.emit();
        return;
      }
      this.statusValue = "error";
      this.errorValue = describe(err);
      this.emit();
    }
  }

  /**
   * Expand a cluster (expand-on-click): fetch the typed /api/subgraph first
   * page and REPLACE the graph store with it. No-op (null) while another
   * expand is in flight or the call is aborted; failures record
   * expandError and leave the graph store untouched.
   */
  async expand(type: NodeType, signal?: AbortSignal): Promise<MergeResult | null> {
    if (this.expandingValue) return null;
    this.expandingValue = true;
    this.expandErrorValue = null;
    this.emit();
    try {
      const slice = await this.client.subgraph({ type }, { signal });
      if (signal?.aborted) return null;
      this.activeTypeValue = type;
      this.viewValue = "slice";
      return this.graph.replaceSlice(slice);
    } catch (err) {
      if (!signal?.aborted) {
        this.expandErrorValue = describe(err);
      }
      return null;
    } finally {
      this.expandingValue = false;
      this.emit();
    }
  }

  /**
   * Back to the cluster layer (keeps the fetched slice in the graph store).
   */
  collapse(): void {
    if (this.viewValue === "clusters") return;
    this.viewValue = "clusters";
    this.activeTypeValue = null;
    this.expandErrorValue = null;
    this.emit();
  }

  /** Leave the cluster layer for a plain (untyped) slice (manual load). */
  enterSlice(): void {
    if (this.viewValue === "slice") return;
    this.viewValue = "slice";
    this.activeTypeValue = null;
    this.emit();
  }

  /** Tests only: back to the initial state. */
  reset(): void {
    this.clustersValue = [];
    this.statusValue = "idle";
    this.errorValue = null;
    this.viewValue = "clusters";
    this.activeTypeValue = null;
    this.expandingValue = false;
    this.expandErrorValue = null;
    this.emit();
  }
}
