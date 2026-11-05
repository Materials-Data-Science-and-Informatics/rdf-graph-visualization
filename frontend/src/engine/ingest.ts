import * as THREE from "three/webgpu";
import type { GraphStore } from "@/lib/graph-store";
import type { CameraRig } from "./camera-fit";
import type { EngineConfig } from "./config";
import type { GpuGraph } from "./gpu-graph";
import { NODE_LIMIT_DEFAULT } from "./layout-utils";
import type { Vec3 } from "./picking";

export type Rgb = readonly [number, number, number];

/** Previous graph's node ids + (async) positions, for re-root position carry-over. */
export interface CarrySnapshot {
  map: Map<string, Vec3> | null;
  failed: boolean;
}

const CARRY_WAIT_MS = 300;

export function rgbOf(css: string): Rgb {
  const c = new THREE.Color(css); // sRGB hex -> linear working space, as in the prototype
  return [c.r, c.g, c.b];
}

/**
 * Stream ingestion state: turns GraphStore deltas into partial GPU uploads each frame
 * (node window, edge cursor, colours, group visibility, springs adjacency, re-root carry).
 */
export class StreamIngest {
  store: GraphStore | null = null;
  generation = -1;
  /** Show the first N nodes (BFS arrival order) and the edges among them. */
  windowN = NODE_LIMIT_DEFAULT;
  windowDirty = false;
  /** Positions of the previous graph for a re-root (see Engine.captureForReroot). */
  snapshot: CarrySnapshot | null = null; // taken by captureForReroot, consumed by reset
  csrDirty = false;
  visibilityDirty = false;
  readonly hidden = new Set<number>(); // hidden group indices (-1 = unclassified)
  private edgesScanned = 0; // store edges already filtered into the GPU edge list
  private lastCsr = 0;
  private carry: { entry: CarrySnapshot; generation: number; since: number } | null = null;
  private visibilityStale = false;
  private lastVisibility = 0;
  private groupRgb: Rgb[] = [];
  private readonly noGroupRgb: Rgb;
  /** Relation IRI -> CSS colour (config order palette); set by the UI. */
  private relationCss = new Map<string, string>();
  /** Store predicate index -> rgb cache (null = no colour); reset per generation. */
  private relRgb: (Rgb | null)[] = [];

  constructor(private readonly cfg: EngineConfig) {
    this.noGroupRgb = rgbOf(cfg.noGroupColor);
  }

  attach(store: GraphStore): void {
    this.store = store;
    this.generation = -1;
    this.groupRgb = store.groupColors.map((c) => rgbOf(c));
    this.relRgb = [];
  }

  setRelationColors(colors: ReadonlyMap<string, string>): void {
    this.relationCss = new Map(colors);
    this.relRgb = [];
  }

  relColor = (predicate: number): Rgb | null => {
    let c = this.relRgb[predicate];
    if (c === undefined) {
      const css = this.relationCss.get(this.store?.predicates[predicate] ?? "");
      c = css ? rgbOf(css) : null;
      this.relRgb[predicate] = c;
    }
    return c;
  };

  colorOf = (group: number): Rgb =>
    group >= 0 && group < this.groupRgb.length ? this.groupRgb[group] : this.noGroupRgb;

  /** The store restarted: forget the cursors and turn the pending snapshot into a carry. */
  reset(generation: number): void {
    this.generation = generation;
    this.relRgb = []; // predicate indices restart with the store
    const snap = this.snapshot;
    this.snapshot = null;
    this.carry = snap ? { entry: snap, generation, since: performance.now() } : null;
    this.csrDirty = false;
    this.edgesScanned = 0;
    this.windowDirty = false;
  }

  /** Fresh GPU buffers (first use or after a reset): nothing scanned, everything to redo. */
  gpuReplaced(): void {
    this.edgesScanned = 0;
  }

  /** Apply store deltas to the GPU (partial uploads only; existing nodes keep simulating). */
  apply(gpu: GpuGraph, store: GraphStore, now: number, rig: CameraRig): number {
    if (this.carry && store.generation !== this.carry.generation) this.carry = null;
    let carry: Map<string, Vec3> | null = null;
    if (this.carry) {
      const { entry, since } = this.carry;
      if (entry.map) {
        carry = entry.map;
        if (rig.anchorPending && store.nodeCount > 0) {
          rig.anchorPending = false;
          rig.anchorOn(entry.map.get(store.nodeIds[0]));
        }
      } else if (entry.failed || now - since >= CARRY_WAIT_MS) this.carry = null;
      else return 0; // readback pending: hold the new nodes back (they stay queued in the store)
    }
    const ch = store.takeChanges(); // recolours; node/edge cursors are tracked here (windowed)
    const target = Math.min(this.windowN, store.nodeCount);
    const prevNodes = gpu.nodeCount;
    const prevEdges = gpu.edgeCount;
    let heat = 0;
    if (this.windowDirty) {
      this.windowDirty = false;
      if (target < prevNodes) gpu.truncate(target);
      else if (target > prevNodes)
        gpu.addNodes(store, prevNodes, target, 0, store.edgeCount, this.colorOf, carry); // anchors from all edges
      gpu.rescanEdges(store, this.relColor);
      this.edgesScanned = store.edgeCount;
      heat = this.cfg.alphaLimitChange;
      gpu.setSettled(Math.min(prevNodes, target));
    } else {
      if (target > prevNodes) {
        gpu.addNodes(
          store,
          prevNodes,
          target,
          this.edgesScanned,
          store.edgeCount,
          this.colorOf,
          carry
        );
      }
      if (store.edgeCount > this.edgesScanned) {
        gpu.appendEdges(store, this.edgesScanned, store.edgeCount, this.relColor);
        this.edgesScanned = store.edgeCount;
      }
      if (gpu.nodeCount > prevNodes || gpu.edgeCount > prevEdges) {
        // Re-heat modestly. Nodes that existed before this growth keep only `oldMobility`
        // of the force, so a settled layout barely moves while newcomers find their place
        // (one uniform comparison, no per-node state). First batch: everyone is new.
        gpu.setSettled(prevNodes);
        heat = prevNodes === 0 ? this.cfg.alphaStart : this.cfg.alphaBump;
      }
    }
    if (ch.recoloredNodes.length) {
      gpu.recolor(
        ch.recoloredNodes.filter((i) => i < gpu.nodeCount),
        store,
        this.colorOf
      );
    }
    if (this.hidden.size > 0 && (ch.recoloredNodes.length || gpu.nodeCount > prevNodes)) {
      this.visibilityStale = true; // new/recoloured nodes were written fully visible
    }
    // user toggles apply at once; growth/recolour re-applies are throttled (full upload)
    if (this.visibilityDirty || (this.visibilityStale && now - this.lastVisibility >= 100)) {
      this.visibilityDirty = this.visibilityStale = false;
      this.lastVisibility = now;
      gpu.applyVisibility(store.groups, store.groupNames.length, this.hidden);
    }
    let alpha = 0; // minimum layout alpha this frame asks for
    if (heat > 0) {
      this.csrDirty = true;
      alpha = heat;
    }
    // Springs adjacency: full rebuild + upload, throttled while streaming (trailing edge
    // is covered because this runs every frame while csrDirty).
    if (this.csrDirty && now - this.lastCsr >= this.cfg.csrIntervalMs) {
      gpu.rebuildCsr();
      alpha = Math.max(alpha, this.cfg.alphaBump / 2); // springs just changed
      this.csrDirty = false;
      this.lastCsr = now;
    }
    return alpha;
  }
}
