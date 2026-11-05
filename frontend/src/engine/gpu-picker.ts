import * as THREE from "three/webgpu";
import type { GpuGraph } from "./gpu-graph";
import { choosePick, type PickHit } from "./picking";

const PICK_N = 9; // pick window (device px): +-4 px around the pointer

/** Owns the small render target that GPU picking renders the id twins into. */
export class GpuPicker {
  private readonly rt = new THREE.RenderTarget(PICK_N, PICK_N, {
    depthBuffer: true,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  private readonly size = new THREE.Vector2();
  private readonly clear = new THREE.Color();

  /**
   * GPU pick at client position: renders the id twins of the nodes/edges into a 9x9 target
   * (camera view offset = the window around the pointer, so only ~81 fragments are shaded;
   * vertex work equals one cheap extra frame of the instanced draws), then reads the 324
   * bytes back asynchronously. Resolves with the nearest node, else the nearest edge.
   */
  pick(
    r: THREE.WebGPURenderer,
    camera: THREE.PerspectiveCamera,
    gpu: GpuGraph,
    clientX: number,
    clientY: number
  ): Promise<PickHit | null> {
    const nodes = gpu.nodeCount;
    const edges = gpu.edgeCount;
    const rect = r.domElement.getBoundingClientRect();
    r.getDrawingBufferSize(this.size);
    const sx = this.size.x / Math.max(1, rect.width);
    const sy = this.size.y / Math.max(1, rect.height);
    const px = Math.floor((clientX - rect.left) * sx);
    const py = Math.floor((clientY - rect.top) * sy);
    const half = (PICK_N - 1) / 2;
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    const prevRT = r.getRenderTarget();
    camera.setViewOffset(this.size.x, this.size.y, px - half, py - half, PICK_N, PICK_N);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.rt);
    try {
      void r.render(gpu.pickScene, camera);
    } finally {
      r.setRenderTarget(prevRT);
      r.setClearColor(this.clear, prevAlpha);
      camera.clearViewOffset();
    }
    return r.readRenderTargetPixelsAsync(this.rt, 0, 0, PICK_N, PICK_N).then((buf) => {
      const c = choosePick(buf as unknown as Uint8Array, PICK_N);
      if (!c) return null;
      if (c.kind === "node") return c.index < nodes ? { kind: "node", index: c.index } : null;
      if (c.index >= edges) return null;
      return {
        kind: "edge",
        index: c.index,
        src: gpu.edgeCpu[2 * c.index],
        dst: gpu.edgeCpu[2 * c.index + 1],
        storeEdge: gpu.edgeStoreCpu[c.index],
      };
    });
  }

  dispose(): void {
    this.rt.dispose();
  }
}
