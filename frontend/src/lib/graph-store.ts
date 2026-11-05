import type { GraphGroupConfig, StreamEvent } from "./api";

/** Deltas since the previous `takeChanges()` (index ranges are half-open). */
export interface GraphChanges {
  version: number;
  /** Incremented by `reset()`: a change of generation means re-root, not growth. */
  generation: number;
  newNodeStart: number;
  newNodeEnd: number;
  newEdgeStart: number;
  newEdgeEnd: number;
  /** Nodes that existed before this window and got a (new) group. */
  recoloredNodes: number[];
  /** Nodes that existed before this window and got a (new) label. */
  relabeledNodes: number[];
  /** Whether a new predicate was added to the table. */
  predicatesChanged: boolean;
  empty: boolean;
}

export interface NodeRelationView {
  predicateIndex: number;
  predicateShort: string;
  dir: "out" | "in";
  otherIndex: number;
}

const INITIAL_CAPACITY = 1024;
/** Uint16 slot reserved for predicates beyond the table size. */
export const OTHER_PREDICATE = 0xffff;

/** Local name of an IRI: text after the last `/` or `#`. */
export function shortName(iri: string): string {
  const i = Math.max(iri.lastIndexOf("/"), iri.lastIndexOf("#"));
  return i >= 0 && i < iri.length - 1 ? iri.slice(i + 1) : iri;
}

function grow<T extends Uint8Array | Int16Array | Uint16Array | Uint32Array>(a: T, n: number): T {
  const b = new (a.constructor as new (n: number) => T)(n);
  b.set(a);
  return b;
}

/**
 * In-memory graph for the GPU engine. Typed arrays (capacity doubling) are
 * exposed directly; only `[0, nodeCount)` / `[0, edgeCount)` is valid, and the
 * array objects are replaced on growth (re-read them after `apply`).
 */
export class GraphStore {
  version = 0;
  generation = 0;
  nodeCount = 0;
  edgeCount = 0;
  /** Largest hop seen in `nodes`/`edges` events. */
  maxHop = 0;
  /** `max_nodes` of the stream's meta event (null until it arrives); sizes the GPU buffers. */
  maxNodes: number | null = null;

  nodeIds: string[] = [];
  /** label per node, null = none yet. */
  labels: (string | null)[] = [];
  /** group index per node (-1 = none). */
  groups = new Int16Array(INITIAL_CAPACITY).fill(-1);
  /** hop at which the node was first seen (a node created lazily from an edge gets that edge event's hop). */
  hops = new Int16Array(INITIAL_CAPACITY).fill(-1);
  /** (src, dst) index pairs: edge e is at [2e], [2e+1]. */
  edges = new Uint32Array(INITIAL_CAPACITY * 2);
  edgePredicate = new Uint16Array(INITIAL_CAPACITY);

  predicates: string[] = [];
  predicateShort: string[] = [];

  readonly groupNames: string[];
  readonly groupColors: string[];

  private readonly index = new Map<string, number>();
  private readonly predIndex = new Map<string, number>();
  private readonly groupIndex = new Map<string, number>();

  private takenNodes = 0;
  private takenEdges = 0;
  private recolored = new Set<number>();
  private relabeled = new Set<number>();
  private predicatesDirty = false;

  private csr: {
    edgeCount: number;
    nodeCount: number;
    offsets: Uint32Array;
    items: Uint32Array;
  } | null = null;

  constructor(groups: readonly Pick<GraphGroupConfig, "name" | "color">[] = []) {
    this.groupNames = groups.map((g) => g.name);
    this.groupColors = groups.map((g) => g.color);
    groups.forEach((g, i) => this.groupIndex.set(g.name, i));
  }

  indexOf(id: string): number {
    return this.index.get(id) ?? -1;
  }

  /** Clear all data (keeps group config); the caller keeps the old store if it needs old positions. */
  reset(): void {
    this.index.clear();
    this.predIndex.clear();
    this.nodeIds = [];
    this.labels = [];
    this.predicates = [];
    this.predicateShort = [];
    this.groups = new Int16Array(INITIAL_CAPACITY).fill(-1);
    this.hops = new Int16Array(INITIAL_CAPACITY).fill(-1);
    this.edges = new Uint32Array(INITIAL_CAPACITY * 2);
    this.edgePredicate = new Uint16Array(INITIAL_CAPACITY);
    this.nodeCount = 0;
    this.edgeCount = 0;
    this.maxHop = 0;
    this.maxNodes = null;
    this.takenNodes = 0;
    this.takenEdges = 0;
    this.recolored.clear();
    this.relabeled.clear();
    this.predicatesDirty = false;
    this.csr = null;
    this.version++;
    this.generation++;
  }

  apply(event: StreamEvent): void {
    switch (event.type) {
      case "meta":
        this.maxNodes = event.max_nodes;
        break;
      case "nodes":
        for (const n of event.nodes) {
          const i = this.ensureNode(n.id, event.hop);
          if (n.group != null) this.setGroup(i, n.group);
        }
        this.maxHop = Math.max(this.maxHop, event.hop);
        this.version++;
        break;
      case "edges":
        for (const e of event.edges) this.addEdge(e.s, e.p, e.o, event.hop);
        this.maxHop = Math.max(this.maxHop, event.hop);
        this.version++;
        break;
      case "types":
        for (const [id, group] of Object.entries(event.types)) {
          const i = this.index.get(id);
          if (i !== undefined) this.setGroup(i, group);
        }
        this.version++;
        break;
      case "labels":
        for (const [id, label] of Object.entries(event.labels)) {
          const i = this.index.get(id);
          if (i === undefined || this.labels[i] === label) continue;
          this.labels[i] = label;
          if (i < this.takenNodes) this.relabeled.add(i);
        }
        this.version++;
        break;
      default:
        break; // progress/ping/error/done carry no graph data
    }
  }

  /** Deltas since the last call. */
  takeChanges(): GraphChanges {
    const c: GraphChanges = {
      version: this.version,
      generation: this.generation,
      newNodeStart: this.takenNodes,
      newNodeEnd: this.nodeCount,
      newEdgeStart: this.takenEdges,
      newEdgeEnd: this.edgeCount,
      recoloredNodes: [...this.recolored],
      relabeledNodes: [...this.relabeled],
      predicatesChanged: this.predicatesDirty,
      empty: false,
    };
    c.empty =
      c.newNodeStart === c.newNodeEnd &&
      c.newEdgeStart === c.newEdgeEnd &&
      !c.recoloredNodes.length &&
      !c.relabeledNodes.length &&
      !c.predicatesChanged;
    this.takenNodes = this.nodeCount;
    this.takenEdges = this.edgeCount;
    this.recolored.clear();
    this.relabeled.clear();
    this.predicatesDirty = false;
    return c;
  }

  /** Relations of node `index`, lazily built CSR (rebuilt after growth). */
  relationsOf(index: number): NodeRelationView[] {
    if (index < 0 || index >= this.nodeCount) return [];
    const { offsets, items } = this.adjacency();
    const out: NodeRelationView[] = [];
    for (let k = offsets[index]; k < offsets[index + 1]; k++) {
      const e = items[k];
      const src = this.edges[2 * e];
      const dst = this.edges[2 * e + 1];
      const p = this.edgePredicate[e];
      const isOut = src === index;
      out.push({
        predicateIndex: p,
        predicateShort: this.predicateShort[p],
        dir: isOut ? "out" : "in",
        otherIndex: isOut ? dst : src,
      });
    }
    return out;
  }

  private adjacency() {
    if (this.csr && this.csr.edgeCount === this.edgeCount && this.csr.nodeCount === this.nodeCount)
      return this.csr;
    const n = this.nodeCount;
    const offsets = new Uint32Array(n + 1);
    for (let e = 0; e < this.edgeCount; e++) {
      const s = this.edges[2 * e];
      const d = this.edges[2 * e + 1];
      offsets[s + 1]++;
      if (d !== s) offsets[d + 1]++;
    }
    for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
    const fill = offsets.slice(0, n);
    const items = new Uint32Array(offsets[n]);
    for (let e = 0; e < this.edgeCount; e++) {
      const s = this.edges[2 * e];
      const d = this.edges[2 * e + 1];
      items[fill[s]++] = e;
      if (d !== s) items[fill[d]++] = e;
    }
    this.csr = { edgeCount: this.edgeCount, nodeCount: this.nodeCount, offsets, items };
    return this.csr;
  }

  private setGroup(i: number, group: string | null): void {
    const g = group === null ? -1 : (this.groupIndex.get(group) ?? -1);
    if (this.groups[i] === g) return;
    this.groups[i] = g;
    if (i < this.takenNodes) this.recolored.add(i);
  }

  private ensureNode(id: string, hop: number): number {
    const existing = this.index.get(id);
    if (existing !== undefined) {
      if (this.hops[existing] < 0) this.hops[existing] = hop;
      return existing;
    }
    const i = this.nodeCount++;
    if (i >= this.groups.length) {
      const cap = this.groups.length * 2;
      const oldCap = this.groups.length;
      this.groups = grow(this.groups, cap).fill(-1, oldCap);
      this.hops = grow(this.hops, cap).fill(-1, oldCap);
    }
    this.index.set(id, i);
    this.nodeIds.push(id);
    this.labels.push(null);
    this.groups[i] = -1;
    this.hops[i] = hop;
    return i;
  }

  private predicateId(iri: string): number {
    let p = this.predIndex.get(iri);
    if (p === undefined) {
      p = this.predicates.length;
      if (p >= OTHER_PREDICATE) {
        // table full: the last slot is a reserved "(other)" bucket, never a real predicate
        if (this.predicates.length === OTHER_PREDICATE) {
          this.predicates.push("(other)");
          this.predicateShort.push("(other)");
          this.predicatesDirty = true;
        }
        return OTHER_PREDICATE;
      }
      this.predicates.push(iri);
      this.predicateShort.push(shortName(iri));
      this.predIndex.set(iri, p);
      this.predicatesDirty = true;
    }
    return p;
  }

  private addEdge(s: string, p: string, o: string, hop: number): void {
    // The backend emits a node before its edges; tolerate violations lazily.
    const si = this.ensureNode(s, hop);
    const oi = this.ensureNode(o, hop);
    const e = this.edgeCount++;
    if (e >= this.edgePredicate.length) {
      const cap = this.edgePredicate.length * 2;
      this.edgePredicate = grow(this.edgePredicate, cap);
      this.edges = grow(this.edges, cap * 2);
    }
    this.edges[2 * e] = si;
    this.edges[2 * e + 1] = oi;
    this.edgePredicate[e] = this.predicateId(p);
  }
}
