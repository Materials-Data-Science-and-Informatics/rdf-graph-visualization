import * as THREE from "three/webgpu";
import type { GraphStore } from "@/lib/graph-store";
import { edgeOpacity, nodeRadius, type EngineConfig } from "./config";
import { EDGE_CURVATURE, EDGE_SEGMENTS, UNTYPED_ALPHA } from "./curve";
import { applyCarry, type Vec3 } from "./picking";
import {
  buildCsr,
  coalesceRanges,
  computeAnchors,
  fillVisibility,
  appendWindowEdges,
  jitterRadius,
} from "./layout-utils";
import {
  NONE,
  attrOf,
  createUniforms,
  markRanges,
  uintBuf,
  vec4Buf,
  type ComputeNodeT,
  type GpuBuffers,
} from "./gpu-buffers";
import { buildInit, buildStep } from "./gpu-kernels";
import {
  createEdgeMaterials,
  createNodeMaterial,
  createPickMaterials,
  stripGeometry,
} from "./gpu-materials";

/** State carried over when buffers are re-created bigger (see Engine.ensureCapacity). */
export interface GpuSeed {
  pos: Float32Array;
  vel: Float32Array;
  colors: Float32Array;
  edges: Uint32Array;
  edgeStore: Uint32Array;
  edgeColors: Float32Array;
  nodeCount: number;
  edgeCount: number;
}

/** Store predicate index -> linear rgb of its relation colour, or null (theme grey). */
export type RelColorFn = (predicate: number) => readonly [number, number, number] | null;

/**
 * All GPU resources for one capacity: node buffers (position/velocity/colour), edge
 * index buffer, CSR buffers, compute kernels (force step + spawn init) and the two
 * draw objects (sprite impostors, line segments). Node/edge counts are uniforms/draw
 * counts, so growth within capacity never recompiles anything.
 */
export class GpuGraph {
  readonly nodeCap: number;
  readonly edgeCap: number;
  nodeCount = 0;
  edgeCount = 0;

  // CPU mirrors that are only ever written partially (never hold live positions).
  readonly colorCpu: Float32Array;
  readonly edgeCpu: Uint32Array;
  /** Per GPU edge: relation colour rgb, w = 1 when the relation has a colour. */
  readonly edgeColorCpu: Float32Array;
  /** GPU edge-list index -> GraphStore edge index (for predicate lookup on pick). */
  readonly edgeStoreCpu: Uint32Array;
  private readonly initCpu: Float32Array;
  private readonly offsetsCpu: Uint32Array;
  private readonly neighCpu: Uint32Array;

  private readonly b: GpuBuffers;
  private readonly u = createUniforms();
  private dark = true;
  private opacityScale = 1;
  private readonly pickShaft: THREE.Mesh;
  private readonly straightQuad: THREE.InstancedBufferGeometry;
  private readonly posCpu: Float32Array;

  private readonly stepKernel: ComputeNodeT;
  private readonly initKernel: ComputeNodeT;
  private readonly sprite: THREE.Sprite;
  private readonly shaft: THREE.Mesh;
  private readonly arrows: THREE.Mesh;
  private readonly shaftGeo: THREE.InstancedBufferGeometry;
  private readonly arrowGeo: THREE.InstancedBufferGeometry;
  private readonly shaftMat: THREE.MeshBasicNodeMaterial;
  private readonly arrowMat: THREE.MeshBasicNodeMaterial;
  private readonly nodeMat: THREE.SpriteNodeMaterial;
  /** ID-colour copies of the node/edge draws (same buffers, same counts) for GPU picking. */
  readonly pickScene = new THREE.Scene();
  private readonly pickSprite: THREE.Sprite;
  private readonly pickArrows: THREE.Mesh;
  private readonly pickMats: THREE.Material[] = [];
  private pendingInit = false;
  private frame = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly cfg: EngineConfig,
    nodeCap: number,
    edgeCap: number,
    seed?: GpuSeed
  ) {
    this.nodeCap = nodeCap;
    this.edgeCap = edgeCap;
    const posArr = new Float32Array(nodeCap * 4);
    const velArr = new Float32Array(nodeCap * 4);
    this.colorCpu = new Float32Array(nodeCap * 4);
    this.edgeCpu = new Uint32Array(edgeCap * 2);
    this.edgeStoreCpu = new Uint32Array(edgeCap);
    this.edgeColorCpu = new Float32Array(edgeCap * 4);
    this.initCpu = new Float32Array(nodeCap * 4);
    this.offsetsCpu = new Uint32Array(nodeCap + 1);
    this.neighCpu = new Uint32Array(edgeCap * 2);
    if (seed) {
      posArr.set(seed.pos.subarray(0, seed.nodeCount * 4));
      velArr.set(seed.vel.subarray(0, seed.nodeCount * 4));
      this.colorCpu.set(seed.colors.subarray(0, seed.nodeCount * 4));
      this.edgeCpu.set(seed.edges.subarray(0, seed.edgeCount * 2));
      this.edgeStoreCpu.set(seed.edgeStore.subarray(0, seed.edgeCount));
      this.edgeColorCpu.set(seed.edgeColors.subarray(0, seed.edgeCount * 4));
      this.nodeCount = seed.nodeCount;
      this.edgeCount = seed.edgeCount;
    }

    this.posCpu = posArr;
    const b: GpuBuffers = {
      pos: vec4Buf(posArr),
      vel: vec4Buf(velArr),
      colors: vec4Buf(this.colorCpu),
      initInfo: vec4Buf(this.initCpu),
      offsets: uintBuf(this.offsetsCpu).toReadOnly(),
      neigh: uintBuf(this.neighCpu).toReadOnly(),
      edgeIdx: uintBuf(this.edgeCpu).toReadOnly(),
      edgeCol: vec4Buf(this.edgeColorCpu),
    };
    this.b = b;
    const u = this.u;

    this.stepKernel = buildStep(b, u, cfg, nodeCap);
    this.initKernel = buildInit(b, u, nodeCap);

    // nodes: one instanced draw, sphere impostor shaded in the fragment stage
    this.nodeMat = createNodeMaterial(b, u);

    this.sprite = new THREE.Sprite(this.nodeMat);
    this.sprite.count = 0;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
    this.scene.add(this.sprite);

    // Edges: camera-facing quads (WebGPU lines are always 1px) plus flat arrowhead
    // triangles at the target end: 2 instanced draws, one instance per edge. Endpoints come
    // from the position buffer via the edge index buffer; geometry holds only the unit
    // quad / triangle. Both stop at the sphere surfaces (radius uRad). The shaft is a quadratic Bezier strip
    // (EDGE_SEGMENTS segments, uCurv = 0 for straight); colour comes from the node colours.
    const quad = stripGeometry(EDGE_SEGMENTS);
    const tri = new THREE.InstancedBufferGeometry();
    // x: 1 = tip, 0 = base; y: -0.5..0.5 across the base
    tri.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, -0.5, 0, 0, 0.5, 0]), 3)
    );
    tri.instanceCount = 0;
    this.straightQuad = stripGeometry(1);
    this.shaftGeo = quad;
    this.arrowGeo = tri;
    const { shaftMat, arrowMat } = createEdgeMaterials(b, u);
    this.shaftMat = shaftMat;
    this.arrowMat = arrowMat;
    this.shaft = new THREE.Mesh(quad, this.shaftMat);
    this.arrows = new THREE.Mesh(tri, this.arrowMat);
    for (const m of [this.shaft, this.arrows]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }
    this.u.uRad.value = nodeRadius(cfg.rest);

    // GPU picking: id-colour twins of the three draws, rendered on demand by the engine
    const { pickNodeMat, pickShaftMat, pickArrowMat } = createPickMaterials(b, u);
    this.pickSprite = new THREE.Sprite(pickNodeMat);
    this.pickSprite.frustumCulled = false;
    this.pickSprite.count = 0;
    const pickShaft = new THREE.Mesh(quad, pickShaftMat);
    this.pickShaft = pickShaft;
    this.pickArrows = new THREE.Mesh(tri, pickArrowMat);
    this.pickMats.push(pickNodeMat, pickShaftMat, pickArrowMat);
    for (const m of [this.pickSprite, pickShaft, this.pickArrows]) {
      m.frustumCulled = false;
      this.pickScene.add(m);
    }
    this.syncCounts();
  }

  private syncCounts(): void {
    this.u.uCount.value = this.nodeCount;
    this.u.uCountF.value = this.nodeCount;
    this.u.uRepK.value = (this.cfg.repulsion * this.nodeCount) / this.cfg.samples;
    this.sprite.count = this.nodeCount;
    this.pickSprite.count = this.nodeCount;
    this.sprite.visible = this.nodeCount > 0;
    this.shaftGeo.instanceCount = this.edgeCount;
    this.straightQuad.instanceCount = this.edgeCount;
    this.arrowGeo.instanceCount = this.edgeCount;
    const o = Math.min(1, edgeOpacity(this.edgeCount, this.dark) * this.opacityScale);
    this.u.uShaftOp.value = o;
    this.u.uArrowOp.value = Math.min(1, o + 0.15);
  }

  /** Forget everything (generation change). GPU contents of old nodes are overwritten on respawn. */
  clear(): void {
    this.nodeCount = 0;
    this.edgeCount = 0;
    this.pendingInit = false;
    this.offsetsCpu.fill(0);
    this.markCsrUploaded();
    this.syncCounts();
  }

  /**
   * Activate nodes [from, to) of `store`: write colours (partial upload) and schedule the
   * spawn kernel next to each node's anchor. `colorOf` maps a group index (-1 = none) to rgb.
   */
  addNodes(
    store: GraphStore,
    from: number,
    to: number,
    edgeFrom: number,
    edgeTo: number,
    colorOf: (group: number) => readonly [number, number, number],
    carry?: ReadonlyMap<string, Vec3> | null
  ): void {
    if (to <= from) return;
    const { anchor, depth } = computeAnchors(store.edges, edgeFrom, edgeTo, from, to);
    const orphanRadius = this.cfg.rest * (1 + Math.cbrt(to) * 0.6) * 0.5;
    for (let i = from; i < to; i++) {
      const a = anchor[i - from];
      this.initCpu[i * 4] = a;
      this.initCpu[i * 4 + 1] =
        a >= 0 ? jitterRadius(this.cfg.rest, depth[i - from]) : orphanRadius;
      const [r, g, b] = colorOf(store.groups[i]);
      this.colorCpu.set([r, g, b, store.groups[i] >= 0 ? 1 : UNTYPED_ALPHA], i * 4);
    }
    const carried = carry
      ? applyCarry(store.nodeIds, from, to, carry, this.posCpu, this.initCpu)
      : [];
    if (!carry) for (let i = from; i < to; i++) this.initCpu[i * 4 + 2] = 0;
    markRanges(attrOf(this.b.pos), coalesceRanges(carried), 4);
    const range = [{ start: from, end: to }];
    markRanges(attrOf(this.b.initInfo), range, 4);
    markRanges(attrOf(this.b.colors), range, 4);
    this.u.uInitStart.value = from;
    this.u.uInitEnd.value = to;
    this.pendingInit = true;
    this.nodeCount = to;
    this.syncCounts();
  }

  /** Recolour existing nodes (types arrive after nodes): partial colour upload only. */
  recolor(
    indices: Iterable<number>,
    store: GraphStore,
    colorOf: (group: number) => readonly [number, number, number]
  ): void {
    const ranges = coalesceRanges(indices);
    for (const r of ranges) {
      for (let i = r.start; i < Math.min(r.end, this.nodeCount); i++) {
        const [cr, cg, cb] = colorOf(store.groups[i]);
        this.colorCpu.set([cr, cg, cb, store.groups[i] >= 0 ? 1 : UNTYPED_ALPHA], i * 4);
      }
    }
    markRanges(attrOf(this.b.colors), ranges, 4);
  }

  /**
   * Append store edges [from, to) whose endpoints are both inside the active window
   * (index < nodeCount) to the edge index buffer (partial upload) and the draw count.
   */
  appendEdges(store: GraphStore, from: number, to: number, relColor: RelColorFn): void {
    if (to <= from) return;
    const start = this.edgeCount;
    this.mapStoreEdges(store, from, to, start);
    this.edgeCount = appendWindowEdges(
      store.edges,
      from,
      to,
      this.nodeCount,
      this.edgeCpu,
      this.edgeCount
    );
    markRanges(attrOf(this.b.edgeIdx), [{ start: start * 2, end: this.edgeCount * 2 }], 1);
    this.fillEdgeColors(store, start, this.edgeCount, relColor);
    markRanges(attrOf(this.b.edgeCol), [{ start, end: this.edgeCount }], 4);
    this.syncCounts();
  }

  /** Relation colours of GPU edges [from, to) (from their store predicate). */
  private fillEdgeColors(store: GraphStore, from: number, to: number, relColor: RelColorFn): void {
    for (let i = from; i < to; i++) {
      const rgb = relColor(store.edgePredicate[this.edgeStoreCpu[i]]);
      if (rgb) this.edgeColorCpu.set([rgb[0], rgb[1], rgb[2], 1], i * 4);
      else this.edgeColorCpu[i * 4 + 3] = 0;
    }
  }

  /** Record the store index of every edge in [from, to) that appendWindowEdges will keep (same filter). */
  private mapStoreEdges(store: GraphStore, from: number, to: number, dstCount: number): void {
    let n = dstCount;
    for (let e = from; e < to; e++) {
      if (store.edges[2 * e] < this.nodeCount && store.edges[2 * e + 1] < this.nodeCount) {
        this.edgeStoreCpu[n++] = e;
      }
    }
  }

  /** Window changed: rebuild the whole windowed edge list (full upload). */
  rescanEdges(store: GraphStore, relColor: RelColorFn): void {
    this.mapStoreEdges(store, 0, store.edgeCount, 0);
    this.edgeCount = appendWindowEdges(
      store.edges,
      0,
      store.edgeCount,
      this.nodeCount,
      this.edgeCpu,
      0
    );
    this.fillEdgeColors(store, 0, this.edgeCount, relColor);
    for (const buf of [this.b.edgeIdx, this.b.edgeCol]) {
      const attr = attrOf(buf);
      attr.clearUpdateRanges(); // a full upload must not be narrowed by stale partial ranges
      attr.needsUpdate = true;
    }
    this.syncCounts();
  }

  /** Shrink the active window (nodes >= n are dropped from simulation and drawing). */
  truncate(n: number): void {
    this.nodeCount = Math.min(this.nodeCount, n);
    this.pendingInit = false;
    this.syncCounts();
  }

  /** Rebuild springs adjacency from the current edges and upload it whole. */
  rebuildCsr(): void {
    buildCsr(this.edgeCpu, this.edgeCount, this.nodeCount, this.offsetsCpu, this.neighCpu);
    this.markCsrUploaded();
  }

  private markCsrUploaded(): void {
    attrOf(this.b.offsets).needsUpdate = true;
    attrOf(this.b.neigh).needsUpdate = true;
  }

  setDim(dim: 2 | 3): void {
    this.u.uZOn.value = dim === 2 ? 0 : 1;
  }

  /** Multiplier on the automatic edge opacity (1 = default). */
  setEdgeOpacityScale(scale: number): void {
    this.opacityScale = scale;
    this.syncCounts();
  }

  /** Curved (quadratic Bezier strips, default) or straight (single segment) edges. */
  setCurved(on: boolean): void {
    this.u.uCurv.value = on ? EDGE_CURVATURE : 0;
    const geo = on ? this.shaftGeo : this.straightQuad;
    this.shaft.geometry = geo;
    this.pickShaft.geometry = geo;
    this.syncCounts();
  }

  setArrowsVisible(on: boolean): void {
    this.arrows.visible = on;
    this.pickArrows.visible = on;
  }

  /**
   * Write per-node visibility into the colour alpha (read by node and edge shaders):
   * a node is hidden when `hiddenGroups` has its group (-1 = unclassified). Full upload.
   */
  applyVisibility(groups: Int16Array, groupCount: number, hiddenGroups: ReadonlySet<number>): void {
    fillVisibility(this.colorCpu, groups, this.nodeCount, groupCount, hiddenGroups);
    const attr = attrOf(this.b.colors);
    attr.clearUpdateRanges();
    attr.needsUpdate = true;
  }

  setLook(dark: boolean): void {
    this.dark = dark;
    this.u.uEdgeColor.value.set(dark ? 0x9db4e0 : 0x4a5568);
    this.u.uRing.value.set(dark ? 0xffffff : 0x111827);
    this.syncCounts();
  }

  /** Node radius in world units. */
  get radius(): number {
    return nodeRadius(this.cfg.rest);
  }

  /**
   * One frame: spawn pending nodes (always), then a force step only when `alpha > 0`
   * (alpha 0 = frozen layout, zero GPU simulation cost).
   */
  step(renderer: THREE.WebGPURenderer, alpha: number): void {
    if (this.nodeCount === 0) return;
    if (this.pendingInit) {
      this.u.uFrame.value = this.frame++;
      renderer.compute(this.initKernel);
      this.pendingInit = false;
    }
    if (alpha <= 0) return;
    this.u.uAlpha.value = alpha;
    renderer.compute(this.stepKernel);
  }

  /** Nodes with index < n move at `oldMobility` until the next call (re-heat bookkeeping). */
  setSettled(n: number): void {
    this.u.uSettled.value = n;
    this.u.uOldMob.value = this.cfg.oldMobility;
  }

  /** New repulsion sample sets (graph restart). */
  reseed(): void {
    this.u.uSeed.value = this.u.uSeed.value + 1;
  }

  /** Highlight indices (null = none): hovered node, selected node, hovered edge (GPU edge-list index). */
  setHighlight(hover: number | null, selected: number | null, hoverEdge: number | null): void {
    this.u.uHover.value = hover ?? NONE;
    this.u.uSel.value = selected ?? NONE;
    this.u.uHoverEdge.value = hoverEdge ?? NONE;
  }

  /** Current xyz of one node. */
  async readNode(renderer: THREE.WebGPURenderer, i: number): Promise<[number, number, number]> {
    const buf = await renderer.getArrayBufferAsync(attrOf(this.b.pos), null, i * 16, 16);
    const f = new Float32Array(buf);
    return [f[0], f[1], f[2]];
  }

  /** Read the first `count` positions (vec4 each) back to the CPU. */
  async readPositions(renderer: THREE.WebGPURenderer, count: number): Promise<Float32Array> {
    const buf = await renderer.getArrayBufferAsync(attrOf(this.b.pos), null, 0, count * 16);
    return new Float32Array(buf);
  }

  /** Copy positions/velocities back to the CPU (rare path: capacity growth). */
  async readback(
    renderer: THREE.WebGPURenderer
  ): Promise<{ pos: Float32Array; vel: Float32Array }> {
    const [p, v] = await Promise.all([
      renderer.getArrayBufferAsync(attrOf(this.b.pos)),
      renderer.getArrayBufferAsync(attrOf(this.b.vel)),
    ]);
    return { pos: new Float32Array(p), vel: new Float32Array(v) };
  }

  dispose(): void {
    this.scene.remove(this.sprite, this.shaft, this.arrows);
    this.shaftGeo.dispose();
    this.straightQuad.dispose();
    this.arrowGeo.dispose();
    this.shaftMat.dispose();
    this.arrowMat.dispose();
    this.nodeMat.dispose();
    for (const m of this.pickMats) m.dispose();
    this.stepKernel.dispose();
    this.initKernel.dispose();
    for (const n of [
      this.b.pos,
      this.b.vel,
      this.b.colors,
      this.b.initInfo,
      this.b.offsets,
      this.b.neigh,
      this.b.edgeIdx,
      this.b.edgeCol,
    ])
      attrOf(n).dispatchEvent({ type: "dispose" });
  }
}
