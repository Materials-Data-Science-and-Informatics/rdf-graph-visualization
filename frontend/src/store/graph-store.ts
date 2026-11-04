// Framework-agnostic graph store (card C2), backed by graphology.
//
// The frozen API contract delivers bounded, cursor-paginated slices
// (/api/subgraph). This store accumulates them:
//
//   - replaceSlice(): a fresh load — clears everything, ingests page one.
//   - ingest(slice, cursor): grow the store with a further page. Node
//     attributes are last-write-wins per IRI; edges are de-duplicated per
//     (source, target) pair, and edges referencing unknown nodes are dropped
//     defensively (the backend only emits intra-slice edges).
//   - ingestEntity(slice): merge a /api/expand/{iri} slice (card E1 search
//     jump) with the same node/edge semantics but WITHOUT cursor
//     bookkeeping — an expand page must not clobber the main slice's
//     nextCursor.
//
// "Expand" on the frozen contract means cursor continuation: the most recent
// slice's page.cursor drives the next fetch, so expand-on-click grows the
// store WITHOUT a refetch-all (no cursor-less call, no replace).
//
// The store is a plain observable class (subscribe/getSnapshot), so the React
// binding (use-graph-store.ts) and any non-React consumer share one code path.
// It is deliberately UI-free: fetch, error banners and buttons live in the
// React layer; this module is pure graph state plus selection state.

import Graph from "graphology";
import type { AggregateNode, Edge, Node, Page, SubgraphResponse } from "../api/types";
import type { RendererGraph } from "../render/renderer";
import { getGroupColor } from "../config";

/** Cursor sentinel for the first page (a page fetched with no cursor). */
export const FIRST_PAGE_CURSOR = "";

export interface MergeResult {
  /** Nodes added to the store by this ingest. */
  addedNodes: number;
  /** Existing nodes whose label/type/group/purl changed. */
  updatedNodes: number;
  /** New edges added (endpoints known, pair not yet present). */
  addedEdges: number;
  /** Edges dropped because an endpoint is not (yet) in the store. */
  droppedEdges: number;
  nodeCount: number;
  edgeCount: number;
}

interface NodeAttrs {
  node: Node;
}

interface EdgeAttrs {
  edge: Edge;
}

function sameNode(a: Node, b: Node): boolean {
  return a.label === b.label && a.type === b.type && a.group === b.group && a.purl === b.purl;
}

export class GraphStore {
  private readonly graph = new Graph<NodeAttrs, EdgeAttrs>({ type: "directed" });
  private lastPage: Page | null = null;
  /** Cursors whose pages were already merged ("" = first page). */
  private consumedCursors: Set<string> = new Set();
  private selectedNodeId: string | null = null;
  private focusedNodeId: string | null = null;
  /** Monotonic token; a click on the same node bumps it, so consumers
   *  (fly-to) can re-trigger on every focus request. */
  private focusTick = 0;
  private version = 0;
  private readonly listeners: Set<() => void> = new Set();

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

  // -------------------------------------------------------------------- size

  get nodeCount(): number {
    return this.graph.order;
  }

  get edgeCount(): number {
    return this.graph.size;
  }

  get page(): Page | null {
    return this.lastPage;
  }

  /** Cursor of the next page, or null when the slice is complete. */
  get nextCursor(): string | null {
    const cursor = this.lastPage?.cursor;
    return this.lastPage?.truncated && cursor ? cursor : null;
  }

  /** True when a cursor-continued fetch would grow the store. */
  get canExpand(): boolean {
    return this.nextCursor !== null;
  }

  /** Number of distinct pages merged so far (1 after a first load). */
  get pageCount(): number {
    return this.consumedCursors.size;
  }

  // -------------------------------------------------------------------- look

  hasNode(id: string): boolean {
    return this.graph.hasNode(id);
  }

  getNode(id: string): Node | null {
    return this.graph.hasNode(id) ? this.graph.getNodeAttribute(id, "node") : null;
  }

  nodes(): Node[] {
    return [...this.graph.nodes()].map((id) => this.graph.getNodeAttribute(id, "node"));
  }

  edges(): Edge[] {
    return [...this.graph.edges()].map((edge) => this.graph.getEdgeAttribute(edge, "edge"));
  }

  /** Node counts per data-model group/type (same shape as /api/aggregate). */
  counts(): AggregateNode[] {
    const byGroupType = new Map<string, AggregateNode>();
    for (const id of this.graph.nodes()) {
      const node = this.graph.getNodeAttribute(id, "node");
      const key = `${node.group}\u0000${node.type}`;
      const existing = byGroupType.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        byGroupType.set(key, { group: node.group, type: node.type, count: 1 });
      }
    }
    return [...byGroupType.values()].sort(
      (a, b) => b.count - a.count || a.group.localeCompare(b.group)
    );
  }

  // ------------------------------------------------------------------ mutate

  /**
   * Merge a typed slice into the store. Idempotent: re-ingesting an already
   * merged page changes nothing. `sourceCursor` is the cursor used to fetch
   * the slice ("" for the first page). The slice's page becomes the
   * continuation state (nextCursor / URL `cursor` key).
   */
  ingest(slice: SubgraphResponse, sourceCursor: string = FIRST_PAGE_CURSOR): MergeResult {
    const merged = this.mergeSlice(slice);
    this.lastPage = slice.page;
    this.consumedCursors.add(sourceCursor);
    if (merged.changed) this.emit();
    return { ...merged, nodeCount: this.graph.order, edgeCount: this.graph.size };
  }

  /**
   * Merge a slice WITHOUT touching the /api/subgraph cursor bookkeeping
   * (card E1). Used for /api/expand/{iri} slices, which bring an out-of-slice
   * entity (search hit) into the store as center + 1 hop: their page carries
   * no cursor, and recording it would clobber the in-flight main slice —
   * dropping nextCursor, the "Load more" chain and the URL `cursor` key.
   * Node/edge semantics (last-write-wins, dedup, dangling drop) are the same
   * as ingest(); the merge is idempotent as well.
   */
  ingestEntity(slice: SubgraphResponse): MergeResult {
    const merged = this.mergeSlice(slice);
    if (merged.changed) this.emit();
    return { ...merged, nodeCount: this.graph.order, edgeCount: this.graph.size };
  }

  /**
   * Node/edge merge shared by ingest() and ingestEntity(). Pure graph state:
   * last-write-wins nodes, (source,target)-deduped edges, dangling edges
   * dropped defensively. Returns per-merge counts plus `changed`.
   */
  private mergeSlice(slice: SubgraphResponse): MergeResult & { changed: boolean } {
    const result: MergeResult & { changed: boolean } = {
      addedNodes: 0,
      updatedNodes: 0,
      addedEdges: 0,
      droppedEdges: 0,
      nodeCount: 0,
      edgeCount: 0,
      changed: false,
    };

    for (const node of slice.nodes) {
      if (this.graph.hasNode(node.id)) {
        if (sameNode(this.graph.getNodeAttribute(node.id, "node"), node)) continue;
        this.graph.setNodeAttribute(node.id, "node", node);
        result.updatedNodes += 1;
      } else {
        this.graph.addNode(node.id, { node });
        result.addedNodes += 1;
      }
      result.changed = true;
    }

    for (const edge of slice.edges) {
      if (!this.graph.hasNode(edge.source) || !this.graph.hasNode(edge.target)) {
        result.droppedEdges += 1;
        continue;
      }
      // graphology (directed, non-multi): one edge per pair; a re-encounter
      // is a duplicate, a different id on the same pair keeps the first.
      if (this.graph.hasEdge(edge.source, edge.target)) continue;
      this.graph.addEdge(edge.source, edge.target, { edge });
      result.addedEdges += 1;
      result.changed = true;
    }

    return result;
  }

  /** Fresh load: clear all state, then ingest the (first) slice. */
  replaceSlice(slice: SubgraphResponse): MergeResult {
    this.graph.clear();
    this.lastPage = null;
    this.consumedCursors = new Set();
    this.selectedNodeId = null;
    this.focusedNodeId = null;
    // NOTE: focusTick is deliberately NOT reset (card D1, contract V2): the
    // focus token must stay monotonic across reloads, because the mounted
    // renderer lives longer than a single store generation and gates
    // fly-to on strictly increasing sequences.
    this.emit();
    return this.ingest(slice);
  }

  // -------------------------------------------------------------- selection

  get selectedId(): string | null {
    return this.selectedNodeId;
  }

  /** Node the user clicked (null clears). Unknown ids are rejected (no-op). */
  select(id: string | null): void {
    if (id !== null && !this.graph.hasNode(id)) return;
    if (id !== this.selectedNodeId) {
      this.selectedNodeId = id;
      this.emit();
    }
  }

  get focusId(): string | null {
    return this.focusedNodeId;
  }

  get focusSequence(): number {
    return this.focusTick;
  }

  /**
   * Request camera/fly-to attention on a node (card E1 consumes this).
   * Bumps focusSequence on every call, even for the same id, so repeated
   * clicks re-trigger. Unknown ids are ignored.
   */
  focus(id: string): void {
    if (!this.graph.hasNode(id)) return;
    this.focusedNodeId = id;
    this.focusTick += 1;
    this.emit();
  }

  // ------------------------------------------------------------------ render

  /**
   * Current store contents as renderer data (fresh copies each call — the
   * mounted renderer owns the handed objects and may mutate them in place,
   * CONTRACT.md §4).
   */
  toGraphData(): RendererGraph {
    const nodes = this.nodes().map((node) => ({
      id: node.id,
      label: node.label,
      group: node.group,
      color: getGroupColor(node.group),
    }));

    const colorById = new Map(nodes.map((node) => [node.id, node.color ?? "gray"] as const));
    const links = this.edges()
      .filter((edge) => colorById.has(edge.source) && colorById.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        // source colour, else target colour, else default gray (legacy look)
        color: colorById.get(edge.source) ?? colorById.get(edge.target) ?? "gray",
      }));

    return { nodes, links };
  }
}
