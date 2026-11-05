import * as THREE from "three/webgpu";
import {
  Discard,
  Fn,
  If,
  Loop,
  dot,
  float,
  hash,
  instanceIndex,
  positionGeometry,
  instancedArray,
  length,
  max,
  min,
  normalize,
  pow,
  sqrt,
  uint,
  uniform,
  uv,
  vec3,
  vec4,
  cameraPosition,
  cross,
  clamp,
} from "three/tsl";
import type { GraphStore } from "@/lib/graph-store";
import { edgeOpacity, nodeRadius, type EngineConfig } from "./config";
import {
  buildCsr,
  coalesceRanges,
  computeAnchors,
  fillVisibility,
  appendWindowEdges,
  jitterRadius,
  type IndexRange,
} from "./layout-utils";

/** State carried over when buffers are re-created bigger (see Engine.ensureCapacity). */
export interface GpuSeed {
  pos: Float32Array;
  vel: Float32Array;
  colors: Float32Array;
  edges: Uint32Array;
  nodeCount: number;
  edgeCount: number;
}

type Vec4Buf = THREE.StorageBufferNode<"vec4">;
type UintBuf = THREE.StorageBufferNode<"uint">;
type StorageNode = Vec4Buf | UintBuf;
type ComputeNodeT = ReturnType<Vec4Buf["compute"]>;

/**
 * @types/three resolves `instancedArray(x, "uint")` to a uvec4 buffer, which clashes with
 * the real element type (a plain uint); the runtime node is the same class either way,
 * so these helpers fix the type once.
 */
const vec4Buf = (data: Float32Array): Vec4Buf => instancedArray(data, "vec4");
const uintBuf = (data: Uint32Array): UintBuf => instancedArray(data, "uint") as unknown as UintBuf;

/** `Fn(...)()` is typed as a plain Node upstream although it is a callable kernel with `.compute`. */
function kernel(body: () => void, threads: number): ComputeNodeT {
  const call = Fn(body)() as unknown as { compute(n: number): ComputeNodeT };
  return call.compute(threads);
}

/**
 * three 0.187: `instancedArray(...).value` is the StorageInstancedBufferAttribute that
 * backs the GPU buffer (typed loosely upstream, hence the narrow cast).
 */
function attrOf(node: StorageNode): THREE.BufferAttribute {
  return node.value as unknown as THREE.BufferAttribute;
}

/**
 * Partial upload: WebGPUAttributeUtils.updateAttribute() calls
 * `device.queue.writeBuffer` per `updateRanges` entry (element units, not bytes)
 * and clears them, so only the touched slice is written and the GPU-resident
 * simulation state of every other node is left alone.
 */
function markRanges(attr: THREE.BufferAttribute, ranges: IndexRange[], itemSize: number): void {
  if (!ranges.length) return;
  for (const r of ranges) attr.addUpdateRange(r.start * itemSize, (r.end - r.start) * itemSize);
  attr.needsUpdate = true; // bumps version -> picked up by Attributes.update() next use
}

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
  private readonly initCpu: Float32Array;
  private readonly offsetsCpu: Uint32Array;
  private readonly neighCpu: Uint32Array;

  private readonly pos: Vec4Buf;
  private readonly vel: Vec4Buf;
  private readonly colors: Vec4Buf;
  private readonly initInfo: Vec4Buf;
  private readonly offsets: UintBuf;
  private readonly neigh: UintBuf;
  private readonly edgeIdx: UintBuf;

  private readonly uCount = uniform(0, "uint");
  private readonly uCountF = uniform(0);
  private readonly uFrame = uniform(0, "uint");
  private readonly uZOn = uniform(1);
  private readonly uAlpha = uniform(1);
  private readonly uSeed = uniform(0, "uint");
  private readonly uSettled = uniform(0, "uint");
  private readonly uOldMob = uniform(1);
  private readonly uRepK = uniform(0);
  /** Node radius in world units (rest/3 * user scale); drives sphere, edge width and arrow size. */
  private readonly uRad = uniform(1);
  private dark = true;
  private opacityScale = 1;
  private readonly uInitStart = uniform(0, "uint");
  private readonly uInitEnd = uniform(0, "uint");

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
    this.initCpu = new Float32Array(nodeCap * 4);
    this.offsetsCpu = new Uint32Array(nodeCap + 1);
    this.neighCpu = new Uint32Array(edgeCap * 2);
    if (seed) {
      posArr.set(seed.pos.subarray(0, seed.nodeCount * 4));
      velArr.set(seed.vel.subarray(0, seed.nodeCount * 4));
      this.colorCpu.set(seed.colors.subarray(0, seed.nodeCount * 4));
      this.edgeCpu.set(seed.edges.subarray(0, seed.edgeCount * 2));
      this.nodeCount = seed.nodeCount;
      this.edgeCount = seed.edgeCount;
    }

    this.pos = vec4Buf(posArr);
    this.vel = vec4Buf(velArr);
    this.colors = vec4Buf(this.colorCpu);
    this.initInfo = vec4Buf(this.initCpu);
    this.offsets = uintBuf(this.offsetsCpu).toReadOnly();
    this.neigh = uintBuf(this.neighCpu).toReadOnly();
    this.edgeIdx = uintBuf(this.edgeCpu).toReadOnly();

    this.stepKernel = this.buildStep();
    this.initKernel = this.buildInit();

    // nodes: one instanced draw, sphere impostor shaded in the fragment stage
    this.nodeMat = new THREE.SpriteNodeMaterial();
    this.nodeMat.positionNode = this.pos.toAttribute().xyz;
    this.nodeMat.scaleNode = this.uRad.mul(2); // sprite scale = diameter
    this.nodeMat.transparent = false;
    this.nodeMat.depthWrite = true;
    const cAttr = this.colors.toAttribute();
    this.nodeMat.fragmentNode = Fn(() => {
      const q = uv().mul(2).sub(1);
      const r2 = dot(q, q);
      Discard(r2.greaterThan(1));
      const z = sqrt(max(float(1).sub(r2), 0));
      const nrm = vec3(q.x, q.y, z);
      const L = normalize(vec3(-0.4, 0.6, 0.7));
      const diff = max(dot(nrm, L), 0);
      const spec = pow(max(dot(nrm, normalize(L.add(vec3(0, 0, 1)))), 0), 32).mul(0.45);
      const rim = pow(float(1).sub(z), 3).mul(0.35);
      Discard(cAttr.w.lessThan(0.5)); // w = group visibility (see applyVisibility)
      return vec4(cAttr.xyz.mul(diff.mul(0.85).add(0.3)).add(spec).add(rim), 1);
    })();
    this.sprite = new THREE.Sprite(this.nodeMat);
    this.sprite.count = 0;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
    this.scene.add(this.sprite);

    // Edges: camera-facing quads (WebGPU lines are always 1px) plus flat arrowhead
    // triangles at the target end: 2 instanced draws, one instance per edge. Endpoints come
    // from the position buffer via the edge index buffer; geometry holds only the unit
    // quad / triangle. Both stop at the sphere surfaces (radius uRad). No curvature.
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0]), 3)
    );
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    quad.instanceCount = 0;
    const tri = new THREE.InstancedBufferGeometry();
    // x: 1 = tip, 0 = base; y: -0.5..0.5 across the base
    tri.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([1, 0, 0, 0, -0.5, 0, 0, 0.5, 0]), 3)
    );
    tri.instanceCount = 0;
    this.shaftGeo = quad;
    this.arrowGeo = tri;
    const matOpts = {
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    };
    this.shaftMat = new THREE.MeshBasicNodeMaterial(matOpts);
    this.arrowMat = new THREE.MeshBasicNodeMaterial(matOpts);
    const { shaftPos, arrowPos } = this.edgeShaders();
    this.shaftMat.positionNode = shaftPos;
    this.arrowMat.positionNode = arrowPos;
    this.shaft = new THREE.Mesh(quad, this.shaftMat);
    this.arrows = new THREE.Mesh(tri, this.arrowMat);
    for (const m of [this.shaft, this.arrows]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }
    this.uRad.value = nodeRadius(cfg.rest);
    this.syncCounts();
  }

  /** World-space vertex positions of the edge quads / arrowheads (see constructor comment). */
  private edgeShaders() {
    const { pos, colors, edgeIdx, uRad } = this;
    const i = instanceIndex;
    const ia = edgeIdx.element(i.mul(2));
    const ib = edgeIdx.element(i.mul(2).add(1));
    const a = pos.element(ia).xyz;
    const b = pos.element(ib).xyz;
    // an edge with a hidden endpoint collapses to a point (degenerate triangles draw nothing)
    const hidden = colors.element(ia).w.mul(colors.element(ib).w).lessThan(0.5);
    const d = b.sub(a);
    const len = max(length(d), 1e-4);
    const dn = d.div(len);
    const side = normalize(cross(dn, cameraPosition.sub(a.add(b).mul(0.5))).add(vec3(1e-6)));
    const tip = b.sub(dn.mul(uRad));
    const start = a.add(dn.mul(uRad));
    const arrowLen = clamp(len.sub(uRad.mul(2)), 0, uRad.mul(1.4)); // shrinks on very short edges
    const shaftEnd = tip.sub(dn.mul(arrowLen));
    const shaftW = uRad.mul(0.2);
    const t = positionGeometry.x;
    const s = positionGeometry.y;
    const shaftPos = hidden.select(
      a,
      start.add(shaftEnd.sub(start).mul(t)).add(side.mul(s.mul(shaftW)))
    );
    const arrowPos = hidden.select(
      a,
      tip.sub(dn.mul(arrowLen.mul(float(1).sub(t)))).add(side.mul(s.mul(arrowLen).mul(0.8)))
    );
    return { shaftPos, arrowPos };
  }

  private buildStep() {
    const {
      pos,
      vel,
      offsets,
      neigh,
      uCount,
      uCountF,
      uSeed,
      uZOn,
      uAlpha,
      uRepK,
      uSettled,
      uOldMob,
    } = this;
    const k = this.cfg.samples;
    const ring = this.cfg.ringSamples;
    const rest = uniform(this.cfg.rest);
    const spring = uniform(this.cfg.spring);
    const grav = uniform(this.cfg.gravity);
    const damp = uniform(1 - this.cfg.velocityDecay);
    const eps = uniform(this.cfg.epsilon);
    const strength = uniform(this.cfg.repulsion);
    const clamp = uniform(this.cfg.speedClamp * this.cfg.rest);
    // Loose upstream typings (Node vs. swizzle chains): everything below is plain TSL.
    return kernel(() => {
      const idx = instanceIndex;
      If(idx.lessThan(uCount), () => {
        const pi = pos.element(idx).xyz.toVar();
        const vi = vel.element(idx).xyz.toVar();
        const f = vec3(0).toVar();
        // stochastic repulsion: K random samples, fixed per node (idx, sample, seed; no frame
        // term) so the equilibrium is stable, scaled by n/K
        Loop(k, ({ i }) => {
          const h = hash(
            idx
              .mul(uint(1664525))
              .add(uint(i).mul(uint(1013904223)))
              .add(uSeed.mul(uint(747796405)))
          );
          // h in [0,1): map to [0.5, n-0.5) so truncation stays inside [0, n-1] without a clamp
          const j = h.mul(uCountF.sub(1)).add(0.5).toUint();
          const d = pi.sub(pos.element(j).xyz);
          const r2 = dot(d, d).add(eps);
          f.addAssign(d.mul(uRepK).div(r2)); // d3 charge: |F| ~ 1/d
        });
        // 2-hop ring samples: a neighbour's random neighbour (weight 1) keeps the local
        // neighbourhood spread out, which the n/K random samples rarely reach
        const s = offsets.element(idx);
        const e = offsets.element(idx.add(1));
        If(e.greaterThan(s), () => {
          Loop(ring, ({ i }) => {
            const h1 = hash(
              idx
                .mul(uint(2654435761))
                .add(uint(i).mul(uint(40503)))
                .add(uSeed)
            );
            const nb = neigh.element(s.add(h1.mul(float(e.sub(s))).toUint()));
            const ns = offsets.element(nb);
            const ne = offsets.element(nb.add(1));
            const h2 = hash(
              idx
                .mul(uint(97))
                .add(uint(i).mul(uint(7919)))
                .add(uSeed.add(uint(13)))
            );
            const j = neigh.element(ns.add(h2.mul(float(ne.sub(ns))).toUint()));
            const d = pi.sub(pos.element(j).xyz);
            const r2 = max(dot(d, d), eps);
            If(j.notEqual(idx), () => {
              f.addAssign(d.mul(strength).div(r2));
            });
          });
        });
        // springs, d3 forceLink: strength 1/min(deg), the lower-degree node takes the bigger share
        const di = max(float(e.sub(s)), 1);
        Loop({ start: s, end: e, type: "uint", condition: "<" }, ({ i }) => {
          const j = neigh.element(i);
          const dj = max(float(offsets.element(j.add(1)).sub(offsets.element(j))), 1);
          const d = pos.element(j).xyz.sub(pi);
          const dist = max(length(d), 1e-3);
          const share = dj.div(di.add(dj));
          f.addAssign(d.div(dist).mul(dist.sub(rest)).mul(spring).mul(share).div(min(di, dj)));
        });
        f.subAssign(pi.mul(grav)); // centering
        // nodes that predate the current re-heat move at a fraction of the force
        const mob = idx.lessThan(uSettled).select(uOldMob, float(1));
        vi.addAssign(f.mul(uAlpha).mul(mob));
        vi.mulAssign(damp);
        vi.z.mulAssign(uZOn);
        vi.mulAssign(min(float(1), clamp.div(max(length(vi), 1e-6)))); // speed clamp
        pi.addAssign(vi);
        pi.z.assign(pi.z.mul(uZOn));
        pos.element(idx).assign(vec4(pi, 1));
        vel.element(idx).assign(vec4(vi, 0));
      });
    }, this.nodeCap);
  }

  /** Spawn kernel: pos = pos[anchor] + jitter (or origin + jitter), vel = 0, for [initStart, initEnd). */
  private buildInit() {
    const { pos, vel, initInfo, uInitStart, uInitEnd, uFrame, uZOn } = this;
    return kernel(() => {
      const idx = instanceIndex;
      If(idx.greaterThanEqual(uInitStart).and(idx.lessThan(uInitEnd)), () => {
        const info = initInfo.element(idx);
        const base = vec3(0).toVar();
        If(info.x.greaterThanEqual(0), () => {
          base.assign(pos.element(info.x.toUint()).xyz);
        });
        const seed = idx.add(uFrame.mul(7919));
        const rnd = vec3(hash(seed.mul(3)), hash(seed.mul(5).add(1)), hash(seed.mul(11).add(2)))
          .mul(2)
          .sub(1);
        const p = base.add(rnd.mul(info.y)).toVar();
        p.z.mulAssign(uZOn);
        pos.element(idx).assign(vec4(p, 1));
        vel.element(idx).assign(vec4(0, 0, 0, 0));
      });
    }, this.nodeCap);
  }

  private syncCounts(): void {
    this.uCount.value = this.nodeCount;
    this.uCountF.value = this.nodeCount;
    this.uRepK.value = (this.cfg.repulsion * this.nodeCount) / this.cfg.samples;
    this.sprite.count = this.nodeCount;
    this.sprite.visible = this.nodeCount > 0;
    this.shaftGeo.instanceCount = this.edgeCount;
    this.arrowGeo.instanceCount = this.edgeCount;
    const o = Math.min(1, edgeOpacity(this.edgeCount, this.dark) * this.opacityScale);
    this.shaftMat.opacity = o;
    this.arrowMat.opacity = Math.min(1, o + 0.15);
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
    colorOf: (group: number) => readonly [number, number, number]
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
      this.colorCpu.set([r, g, b, 1], i * 4);
    }
    const range = [{ start: from, end: to }];
    markRanges(attrOf(this.initInfo), range, 4);
    markRanges(attrOf(this.colors), range, 4);
    this.uInitStart.value = from;
    this.uInitEnd.value = to;
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
        this.colorCpu.set([cr, cg, cb, 1], i * 4);
      }
    }
    markRanges(attrOf(this.colors), ranges, 4);
  }

  /**
   * Append store edges [from, to) whose endpoints are both inside the active window
   * (index < nodeCount) to the edge index buffer (partial upload) and the draw count.
   */
  appendEdges(store: GraphStore, from: number, to: number): void {
    if (to <= from) return;
    const start = this.edgeCount;
    this.edgeCount = appendWindowEdges(
      store.edges,
      from,
      to,
      this.nodeCount,
      this.edgeCpu,
      this.edgeCount
    );
    markRanges(attrOf(this.edgeIdx), [{ start: start * 2, end: this.edgeCount * 2 }], 1);
    this.syncCounts();
  }

  /** Window changed: rebuild the whole windowed edge list (full upload). */
  rescanEdges(store: GraphStore): void {
    this.edgeCount = appendWindowEdges(
      store.edges,
      0,
      store.edgeCount,
      this.nodeCount,
      this.edgeCpu,
      0
    );
    const attr = attrOf(this.edgeIdx);
    attr.clearUpdateRanges(); // a full upload must not be narrowed by stale partial ranges
    attr.needsUpdate = true;
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
    attrOf(this.offsets).needsUpdate = true;
    attrOf(this.neigh).needsUpdate = true;
  }

  setDim(dim: 2 | 3): void {
    this.uZOn.value = dim === 2 ? 0 : 1;
  }

  /** Multiplier on the automatic edge opacity (1 = default). */
  setEdgeOpacityScale(scale: number): void {
    this.opacityScale = scale;
    this.syncCounts();
  }

  setArrowsVisible(on: boolean): void {
    this.arrows.visible = on;
  }

  /**
   * Write per-node visibility into the colour alpha (read by node and edge shaders):
   * a node is hidden when `hiddenGroups` has its group (-1 = unclassified). Full upload.
   */
  applyVisibility(groups: Int16Array, groupCount: number, hiddenGroups: ReadonlySet<number>): void {
    fillVisibility(this.colorCpu, groups, this.nodeCount, groupCount, hiddenGroups);
    const attr = attrOf(this.colors);
    attr.clearUpdateRanges();
    attr.needsUpdate = true;
  }

  setLook(dark: boolean): void {
    this.dark = dark;
    const color = dark ? 0x9db4e0 : 0x4a5568;
    this.shaftMat.color.set(color);
    this.arrowMat.color.set(color);
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
      this.uFrame.value = this.frame++;
      renderer.compute(this.initKernel);
      this.pendingInit = false;
    }
    if (alpha <= 0) return;
    this.uAlpha.value = alpha;
    renderer.compute(this.stepKernel);
  }

  /** Nodes with index < n move at `oldMobility` until the next call (re-heat bookkeeping). */
  setSettled(n: number): void {
    this.uSettled.value = n;
    this.uOldMob.value = this.cfg.oldMobility;
  }

  /** New repulsion sample sets (graph restart). */
  reseed(): void {
    this.uSeed.value = this.uSeed.value + 1;
  }

  /** Read the first `count` positions (vec4 each) back to the CPU. */
  async readPositions(renderer: THREE.WebGPURenderer, count: number): Promise<Float32Array> {
    const buf = await renderer.getArrayBufferAsync(attrOf(this.pos), null, 0, count * 16);
    return new Float32Array(buf);
  }

  /** Copy positions/velocities back to the CPU (rare path: capacity growth). */
  async readback(
    renderer: THREE.WebGPURenderer
  ): Promise<{ pos: Float32Array; vel: Float32Array }> {
    const [p, v] = await Promise.all([
      renderer.getArrayBufferAsync(attrOf(this.pos)),
      renderer.getArrayBufferAsync(attrOf(this.vel)),
    ]);
    return { pos: new Float32Array(p), vel: new Float32Array(v) };
  }

  dispose(): void {
    this.scene.remove(this.sprite, this.shaft, this.arrows);
    this.shaftGeo.dispose();
    this.arrowGeo.dispose();
    this.shaftMat.dispose();
    this.arrowMat.dispose();
    this.nodeMat.dispose();
    this.stepKernel.dispose();
    this.initKernel.dispose();
    for (const n of [
      this.pos,
      this.vel,
      this.colors,
      this.initInfo,
      this.offsets,
      this.neigh,
      this.edgeIdx,
    ])
      attrOf(n).dispatchEvent({ type: "dispose" });
  }
}
