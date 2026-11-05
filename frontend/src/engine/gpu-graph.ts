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
  vertexIndex,
} from "three/tsl";
import type { GraphStore } from "@/lib/graph-store";
import { edgeOpacity, nodeSize, type EngineConfig } from "./config";
import {
  buildCsr,
  coalesceRanges,
  computeAnchors,
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
  private readonly uRepK = uniform(0);
  private readonly uSize = uniform(1);
  private readonly uInitStart = uniform(0, "uint");
  private readonly uInitEnd = uniform(0, "uint");

  private readonly stepKernel: ComputeNodeT;
  private readonly initKernel: ComputeNodeT;
  private readonly sprite: THREE.Sprite;
  private readonly lines: THREE.LineSegments;
  private readonly lineGeo: THREE.BufferGeometry;
  private readonly lineMat: THREE.LineBasicNodeMaterial;
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
    this.nodeMat.scaleNode = this.uSize;
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
      return vec4(cAttr.xyz.mul(diff.mul(0.85).add(0.3)).add(spec).add(rim), 1);
    })();
    this.sprite = new THREE.Sprite(this.nodeMat);
    this.sprite.count = 0;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
    this.scene.add(this.sprite);

    // edges: one draw; endpoints are fetched from the position buffer through the edge
    // index buffer. The dummy `position` attribute only provides the vertex capacity.
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(edgeCap * 6), 3)
    );
    this.lineGeo.setDrawRange(0, 0);
    this.lineMat = new THREE.LineBasicNodeMaterial({
      color: 0x6f8fd0,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lineMat.positionNode = this.pos.element(this.edgeIdx.element(vertexIndex)).xyz;
    this.lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
    this.syncCounts();
  }

  private buildStep() {
    const { pos, vel, offsets, neigh, uCount, uCountF, uFrame, uZOn, uAlpha, uRepK } = this;
    const k = this.cfg.samples;
    const rest = uniform(this.cfg.rest);
    const spring = uniform(this.cfg.spring);
    const grav = uniform(this.cfg.gravity);
    const damp = uniform(this.cfg.damping);
    const eps = uniform(this.cfg.epsilon * this.cfg.rest * this.cfg.rest);
    const clamp = uniform(this.cfg.speedClamp * this.cfg.rest);
    const jig = uniform(this.cfg.jiggle * this.cfg.rest);
    // Loose upstream typings (Node vs. swizzle chains): everything below is plain TSL.
    return kernel(() => {
      const idx = instanceIndex;
      If(idx.lessThan(uCount), () => {
        const pi = pos.element(idx).xyz.toVar();
        const vi = vel.element(idx).xyz.toVar();
        const f = vec3(0).toVar();
        // stochastic repulsion: K random samples (new set every frame), scaled by n/K
        Loop(k, ({ i }) => {
          const h = hash(
            idx
              .mul(uint(1664525))
              .add(uint(i).mul(uint(1013904223)))
              .add(uFrame.mul(uint(747796405)))
          );
          // h in [0,1): map to [0.5, n-0.5) so truncation stays inside [0, n-1] without a clamp
          const j = h.mul(uCountF.sub(1)).add(0.5).toUint();
          const d = pi.sub(pos.element(j).xyz);
          const r2 = dot(d, d).add(eps);
          f.addAssign(d.mul(uRepK).div(r2.mul(sqrt(r2))));
        });
        // springs over CSR neighbours
        const s = offsets.element(idx);
        const e = offsets.element(idx.add(1));
        const deg = max(float(e.sub(s)), 1);
        Loop({ start: s, end: e, type: "uint", condition: "<" }, ({ i }) => {
          const d = pos.element(neigh.element(i)).xyz.sub(pi);
          const dist = max(length(d), 1e-3);
          f.addAssign(d.div(dist).mul(dist.sub(rest)).mul(spring).div(sqrt(deg)));
        });
        f.subAssign(pi.mul(grav)); // centering
        vi.addAssign(f.mul(uAlpha));
        // jiggle keeps a settled graph alive
        vi.addAssign(
          vec3(
            hash(idx.add(uFrame.mul(3))),
            hash(idx.add(uFrame.mul(5)).add(7)),
            hash(idx.add(uFrame.mul(11)).add(13))
          )
            .sub(0.5)
            .mul(jig)
        );
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
    this.uRepK.value =
      (this.cfg.repulsion * this.cfg.rest ** 3 * this.nodeCount) / this.cfg.samples;
    this.uSize.value = nodeSize(this.cfg.rest, this.nodeCount);
    this.sprite.count = this.nodeCount;
    this.sprite.visible = this.nodeCount > 0;
    this.lineGeo.setDrawRange(0, 2 * this.edgeCount);
    this.lineMat.opacity = edgeOpacity(this.edgeCount);
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

  /** Append store edges [from, to) to the edge index buffer (partial upload) and the draw count. */
  addEdges(store: GraphStore, from: number, to: number): void {
    if (to <= from) return;
    this.edgeCpu.set(store.edges.subarray(from * 2, to * 2), from * 2);
    markRanges(attrOf(this.edgeIdx), [{ start: from * 2, end: to * 2 }], 1);
    this.edgeCount = to;
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

  setLook(dark: boolean): void {
    const m = this.lineMat;
    const blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (m.blending !== blending) {
      m.blending = blending;
      m.needsUpdate = true;
    }
    m.color.set(dark ? 0x6f8fd0 : 0x4a5568);
  }

  /** One frame of simulation: spawn pending nodes, then a force step. */
  step(renderer: THREE.WebGPURenderer, alpha: number): void {
    if (this.nodeCount === 0) return;
    this.uFrame.value = this.frame++;
    this.uAlpha.value = alpha;
    if (this.pendingInit) {
      renderer.compute(this.initKernel);
      this.pendingInit = false;
    }
    renderer.compute(this.stepKernel);
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
    this.scene.remove(this.sprite, this.lines);
    this.lineGeo.dispose();
    this.lineMat.dispose();
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
