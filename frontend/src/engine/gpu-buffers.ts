import * as THREE from "three/webgpu";
import { Fn, instancedArray, uniform } from "three/tsl";
import { EDGE_CURVATURE } from "./curve";
import type { IndexRange } from "./layout-utils";

export type Vec4Buf = THREE.StorageBufferNode<"vec4">;
export type UintBuf = THREE.StorageBufferNode<"uint">;
export type FloatBuf = THREE.StorageBufferNode<"float">;
export type StorageNode = Vec4Buf | UintBuf | FloatBuf;
export type ComputeNodeT = ReturnType<Vec4Buf["compute"]>;

/**
 * @types/three resolves `instancedArray(x, "uint")` to a uvec4 buffer, which clashes with
 * the real element type (a plain uint); the runtime node is the same class either way,
 * so these helpers fix the type once.
 */
export const vec4Buf = (data: Float32Array): Vec4Buf => instancedArray(data, "vec4");
export const uintBuf = (data: Uint32Array): UintBuf =>
  instancedArray(data, "uint") as unknown as UintBuf;

export const floatBuf = (data: Float32Array): FloatBuf =>
  instancedArray(data, "float") as unknown as FloatBuf;

/** `Fn(...)()` is typed as a plain Node upstream although it is a callable kernel with `.compute`. */
export function kernel(body: () => void, threads: number): ComputeNodeT {
  const call = Fn(body)() as unknown as { compute(n: number): ComputeNodeT };
  return call.compute(threads);
}

/**
 * three 0.187: `instancedArray(...).value` is the StorageInstancedBufferAttribute that
 * backs the GPU buffer (typed loosely upstream, hence the narrow cast).
 */
export function attrOf(node: StorageNode): THREE.BufferAttribute {
  return node.value as unknown as THREE.BufferAttribute;
}

/**
 * Partial upload: WebGPUAttributeUtils.updateAttribute() calls
 * `device.queue.writeBuffer` per `updateRanges` entry (element units, not bytes)
 * and clears them, so only the touched slice is written and the GPU-resident
 * simulation state of every other node is left alone.
 */
export function markRanges(
  attr: THREE.BufferAttribute,
  ranges: IndexRange[],
  itemSize: number
): void {
  if (!ranges.length) return;
  for (const r of ranges) attr.addUpdateRange(r.start * itemSize, (r.end - r.start) * itemSize);
  attr.needsUpdate = true; // bumps version -> picked up by Attributes.update() next use
}

/** Sentinel instance index: no highlight. */
export const NONE = 0xffffffff;

/** The storage buffers shared by the compute kernels and the draw materials. */
export interface GpuBuffers {
  pos: Vec4Buf;
  vel: Vec4Buf;
  colors: Vec4Buf;
  /** Per-node radius multiplier (1 = base radius), see node-size.ts. */
  size: FloatBuf;
  initInfo: Vec4Buf;
  offsets: UintBuf;
  neigh: UintBuf;
  edgeIdx: UintBuf;
  edgeCol: Vec4Buf;
}

/** Uniforms shared by the compute kernels and the draw materials. */
export function createUniforms() {
  return {
    uCount: uniform(0, "uint"),
    uCountF: uniform(0),
    uFrame: uniform(0, "uint"),
    uZOn: uniform(1),
    uAlpha: uniform(1),
    uSeed: uniform(0, "uint"),
    uSettled: uniform(0, "uint"),
    uOldMob: uniform(1),
    uRepK: uniform(0),
    /** Node radius in world units (rest/3 * user scale); drives sphere, edge width and arrow size. */
    uRad: uniform(1),
    /** World size of one CSS pixel per unit of camera distance: 2*tan(fov/2)/viewportHeight. */
    uPxWorld: uniform(0.002),
    uCurv: uniform(EDGE_CURVATURE),
    uInitStart: uniform(0, "uint"),
    uInitEnd: uniform(0, "uint"),
    // highlight state (instance indices; NONE = no highlight)
    uHover: uniform(NONE, "uint"),
    uSel: uniform(NONE, "uint"),
    uHoverEdge: uniform(NONE, "uint"),
    uRing: uniform(new THREE.Color(1, 1, 1)),
    uEdgeColor: uniform(new THREE.Color(0x9db4e0)),
    uHoverColor: uniform(new THREE.Color("#f5b82e")),
    uShaftOp: uniform(0.5),
    uArrowOp: uniform(0.65),
  };
}

export type GpuUniforms = ReturnType<typeof createUniforms>;
