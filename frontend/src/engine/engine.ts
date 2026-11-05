import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { GraphStore } from "@/lib/graph-store";
import { DEFAULT_CONFIG, estimateRadius, type EngineConfig } from "./config";
import { GpuGraph } from "./gpu-graph";
import {
  DEFAULT_CAPACITY,
  NODE_LIMIT_DEFAULT,
  fitDistance,
  fitFromPositions,
  growCapacity,
  nextAlpha,
  roundCapacity,
} from "./layout-utils";
import { WebGpuUnavailableError, assertWebGpu, cssToRgb } from "./webgpu";

/** TODO(F4/F5): picking. Node index = store index; `null` = nothing under the pointer. */
export interface EngineHandlers {
  onHover?: (index: number | null) => void;
  onClick?: (index: number | null, event: PointerEvent) => void;
  onContextMenu?: (index: number | null, event: MouseEvent) => void;
}

type Rgb = readonly [number, number, number];
const FIT_EASE = 0.08;
const FOV = 60;

/**
 * GPU graph engine: three WebGPURenderer + TSL compute 3D force layout. WebGPU only
 * (`create` rejects with WebGpuUnavailableError otherwise). One engine for 3D and 2D
 * (2D = z locked through a uniform). Pulls deltas from a GraphStore every frame.
 */
export class Engine {
  /** Called when `GpuGraph` capacity grows (rare path); useful for diagnostics. */
  onCapacityGrow?: (nodeCap: number, edgeCap: number) => void;
  /** Fatal runtime error (loop stopped) or regrow failure; surfaced in the UI. */
  onError?: (message: string) => void;

  private readonly cfg: EngineConfig;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1e6);
  private readonly controls: OrbitControls;
  private readonly resizeObs: ResizeObserver;
  private readonly themeObs: MutationObserver;

  private store: GraphStore | null = null;
  private gpu: GpuGraph | null = null;
  private generation = -1;
  private groupRgb: Rgb[] = [];
  private noGroupRgb: Rgb;
  private rebuilding = false;
  private regrowFailed = false;
  private failed = false;
  private disposed = false;
  private csrDirty = false;
  private lastCsr = 0;
  private alpha: number;
  private dim: 2 | 3 = 3;
  private dark = true;
  /** Show the first N nodes (BFS arrival order) and the edges among them. */
  private windowN = NODE_LIMIT_DEFAULT;
  private windowDirty = false;
  private edgesScanned = 0; // store edges already filtered into the GPU edge list
  private fitting = true;
  private fitCenter = new THREE.Vector3();
  private fitDist = 0;
  private fitValid = false; // true once a measured fit exists for this generation
  private fitBusy = false;
  private lastFitRead = 0;
  private fitAfterFreeze = false;
  private viewDir = new THREE.Vector3(0, 0, 1);
  /** TODO(F4/F5): read by the picking code once it exists. */
  handlers: EngineHandlers = {};
  private readonly hidden = new Set<number>(); // hidden group indices (-1 = unclassified)
  private visibilityDirty = false;
  private visibilityStale = false;
  private lastVisibility = 0;
  private edgeOpacityScale = 1;
  private arrowsOn = true;
  private readonly frameTimes: number[] = [];
  private lastFrame = 0;

  private constructor(
    private readonly host: HTMLElement,
    renderer: THREE.WebGPURenderer,
    cfg: EngineConfig
  ) {
    this.cfg = cfg;
    this.renderer = renderer;
    this.alpha = cfg.alphaStart;
    this.noGroupRgb = this.rgbOf(cfg.noGroupColor);

    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 1e5;
    this.controls.addEventListener("start", () => (this.fitting = false));
    this.setViewDir();
    this.camera.position.copy(this.viewDir).multiplyScalar(this.estimateDist(1));

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();

    this.themeObs = new MutationObserver(() => this.refreshTheme());
    this.themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    this.refreshTheme();

    renderer.setAnimationLoop(() => this.frame());
  }

  /** Mount a renderer into `host`. Rejects with WebGpuUnavailableError when WebGPU is missing. */
  static async create(host: HTMLElement, config: Partial<EngineConfig> = {}): Promise<Engine> {
    await assertWebGpu();
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, cfg.maxPixelRatio));
    try {
      await renderer.init();
    } catch (err) {
      renderer.dispose();
      throw err;
    }
    // three silently falls back to its WebGL2 backend when WebGPU init fails; that
    // backend cannot do the random reads the layout needs, so refuse it.
    if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
      renderer.dispose();
      throw new WebGpuUnavailableError();
    }
    return new Engine(host, renderer, cfg);
  }

  /** Rolling average over the last 60 frames. */
  get fps(): number {
    const t = this.frameTimes;
    if (!t.length) return 0;
    return 1000 / (t.reduce((a, b) => a + b, 0) / t.length);
  }

  /** Connect the graph data source; the engine pulls `takeChanges()` each frame. */
  attach(store: GraphStore): void {
    this.store = store;
    this.generation = -1;
    this.groupRgb = store.groupColors.map((c) => this.rgbOf(c));
  }

  setHandlers(h: EngineHandlers): void {
    this.handlers = h; // TODO(F4/F5): raycast/GPU-pick and call these
  }

  /**
   * Hide/show all nodes of a group (-1 = unclassified). Hidden nodes and edges touching
   * them are not drawn; the layout keeps simulating them.
   */
  setGroupVisible(groupIndex: number, visible: boolean): void {
    if (visible) this.hidden.delete(groupIndex);
    else this.hidden.add(groupIndex);
    this.visibilityDirty = true;
  }

  /** Multiplier on the automatic edge opacity (1 = default). */
  setEdgeOpacityScale(scale: number): void {
    this.edgeOpacityScale = scale;
    this.gpu?.setEdgeOpacityScale(scale);
  }

  setArrowsVisible(on: boolean): void {
    this.arrowsOn = on;
    this.gpu?.setArrowsVisible(on);
  }

  /** 2D = z locked via uniform (positions flatten within a few frames); camera looks down -z. */
  setDim(dim: 2 | 3): void {
    this.dim = dim;
    this.gpu?.setDim(dim);
    this.controls.enableRotate = dim === 3;
    this.alpha = Math.max(this.alpha, this.cfg.alphaBump); // let the z flattening/expansion animate
    this.resetView();
  }

  /** Re-frame the whole graph and resume auto-fit while the graph grows. */
  resetView(): void {
    this.fitting = true;
    this.setViewDir();
    const d = this.camera.position.distanceTo(this.controls.target) || this.estimateDist(1);
    this.camera.position.copy(this.controls.target).addScaledVector(this.viewDir, d);
    this.lastFitRead = 0; // measure again right away
  }

  /** Default orbit direction: +z, elevated by `viewElevationDeg` in 3D; straight on in 2D. */
  private setViewDir(): void {
    const e = this.dim === 2 ? 0 : THREE.MathUtils.degToRad(this.cfg.viewElevationDeg);
    this.viewDir.set(0, Math.sin(e), Math.cos(e));
  }

  /**
   * Show only the first `n` nodes (store indices are in BFS arrival order) and the edges
   * among them, client-side from already loaded data. Re-heats the layout.
   */
  setNodeLimit(n: number): void {
    if (n === this.windowN) return;
    this.windowN = n;
    this.windowDirty = true;
    this.lastFitRead = 0; // re-fit if still auto-fitting
  }

  /** True while the layout is still moving (compute is dispatched). */
  get settling(): boolean {
    return this.alpha > 0;
  }

  /**
   * Hook for F5 (re-root with position carry-over): called when the store's generation
   * changes, before the GPU state is cleared; receives the previous node count.
   */
  onGenerationReset?: (previousNodeCount: number) => void;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    this.themeObs.disconnect();
    this.controls.dispose();
    this.gpu?.dispose();
    this.gpu = null;
    const canvas = this.renderer.domElement;
    this.renderer.dispose();
    canvas.remove();
  }

  // ---- internals ---------------------------------------------------------------

  private rgbOf(css: string): Rgb {
    const c = new THREE.Color(css); // sRGB hex -> linear working space, as in the prototype
    return [c.r, c.g, c.b];
  }

  private colorOf = (group: number): Rgb =>
    group >= 0 && group < this.groupRgb.length ? this.groupRgb[group] : this.noGroupRgb;

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.cfg.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Background follows the app theme (`--background`, possibly oklch -> resolved via canvas). */
  private refreshTheme(): void {
    const css = getComputedStyle(this.host).getPropertyValue("--background").trim();
    const [r, g, b] = cssToRgb(css || "#0a0a0a", [10, 10, 10]);
    this.scene.background = new THREE.Color().setRGB(
      r / 255,
      g / 255,
      b / 255,
      THREE.SRGBColorSpace
    );
    this.dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    this.gpu?.setLook(this.dark);
  }

  private estimateDist(nodeCount: number): number {
    return fitDistance(estimateRadius(this.cfg.rest, nodeCount), FOV);
  }

  private frame(): void {
    if (this.failed) return;
    try {
      this.tick();
    } catch (err) {
      this.failed = true;
      this.renderer.setAnimationLoop(null);
      console.error("Graph engine error", err);
      this.onError?.(`The graph view stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private tick(): void {
    const now = performance.now();
    if (this.lastFrame) {
      this.frameTimes.push(now - this.lastFrame);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
    }
    this.lastFrame = now;

    if (!this.rebuilding) {
      this.pull(now);
      if (this.gpu) {
        this.gpu.step(this.renderer, this.alpha);
        if (this.alpha > 0) {
          this.alpha = nextAlpha(this.alpha, this.cfg.alphaDecay, this.cfg.alphaStop);
          if (this.alpha === 0) this.fitAfterFreeze = true;
        }
      }
    }
    this.updateFit(now);
    this.controls.update();
    void this.renderer.render(this.scene, this.camera);
  }

  /** Apply store deltas to the GPU (partial uploads only; existing nodes keep simulating). */
  private pull(now: number): void {
    const store = this.store;
    if (!store) return;
    if (store.generation !== this.generation) this.resetGeneration(store);
    if (store.nodeCount === 0 && store.edgeCount === 0) return;

    if (!this.ensureCapacity(store)) return; // async regrow in flight; deltas stay queued in the store
    const gpu = this.gpu;
    if (!gpu) return;

    const ch = store.takeChanges(); // recolours; node/edge cursors are tracked here (windowed)
    const target = Math.min(this.windowN, store.nodeCount);
    const prevNodes = gpu.nodeCount;
    const prevEdges = gpu.edgeCount;
    let heat = 0;
    if (this.windowDirty) {
      this.windowDirty = false;
      if (target < prevNodes) gpu.truncate(target);
      else if (target > prevNodes)
        gpu.addNodes(store, prevNodes, target, 0, store.edgeCount, this.colorOf); // anchors from all edges
      gpu.rescanEdges(store);
      this.edgesScanned = store.edgeCount;
      heat = this.cfg.alphaLimitChange;
      gpu.setSettled(Math.min(prevNodes, target));
    } else {
      if (target > prevNodes) {
        gpu.addNodes(store, prevNodes, target, this.edgesScanned, store.edgeCount, this.colorOf);
      }
      if (store.edgeCount > this.edgesScanned) {
        gpu.appendEdges(store, this.edgesScanned, store.edgeCount);
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
    if (heat > 0) {
      this.csrDirty = true;
      this.alpha = Math.max(this.alpha, heat);
    }
    // Springs adjacency: full rebuild + upload, throttled while streaming (trailing edge
    // is covered because this runs every frame while csrDirty).
    if (this.csrDirty && now - this.lastCsr >= this.cfg.csrIntervalMs) {
      gpu.rebuildCsr();
      this.alpha = Math.max(this.alpha, this.cfg.alphaBump / 2); // springs just changed
      this.csrDirty = false;
      this.lastCsr = now;
    }
  }

  private resetGeneration(store: GraphStore): void {
    this.onGenerationReset?.(this.gpu?.nodeCount ?? 0); // TODO(F5): carry positions over
    this.generation = store.generation;
    this.gpu?.clear();
    this.csrDirty = false;
    this.regrowFailed = false;
    this.fitValid = false;
    this.edgesScanned = 0;
    this.windowDirty = false;
    this.gpu?.reseed();
    this.alpha = this.cfg.alphaStart;
    this.resetView();
  }

  /**
   * Returns true when `this.gpu` can hold the store. Buffers are sized for the stream's
   * max_nodes (default 100k) with headroom; if a stream still outgrows them (nodes or
   * edges), buffers are re-created at doubled capacity: positions/velocities are read
   * back with renderer.getArrayBufferAsync, so the layout survives, at the cost of a
   * short pause (simulation skipped while the readback is in flight).
   */
  private ensureCapacity(store: GraphStore): boolean {
    const wantNodes = roundCapacity(Math.max(store.maxNodes ?? DEFAULT_CAPACITY, store.nodeCount));
    const gpu = this.gpu;
    if (!gpu || (gpu.nodeCount === 0 && gpu.nodeCap !== wantNodes)) {
      // nothing on the GPU yet (first use, or after a reset): (re)allocate without readback
      gpu?.dispose();
      this.edgesScanned = 0;
      this.adopt(new GpuGraph(this.scene, this.cfg, wantNodes, 4 * wantNodes));
      return true;
    }
    if (store.nodeCount <= gpu.nodeCap && store.edgeCount <= gpu.edgeCap) return true;
    if (this.regrowFailed) return false; // backoff: no retry until the next generation
    const nodeCap = growCapacity(gpu.nodeCap, store.nodeCount);
    const edgeCap = growCapacity(gpu.edgeCap, store.edgeCount);
    void this.regrow(gpu, nodeCap, edgeCap);
    return false;
  }

  private async regrow(old: GpuGraph, nodeCap: number, edgeCap: number): Promise<void> {
    this.rebuilding = true;
    try {
      const { pos, vel } = await old.readback(this.renderer);
      if (this.disposed) return;
      const next = new GpuGraph(this.scene, this.cfg, nodeCap, edgeCap, {
        pos,
        vel,
        colors: old.colorCpu,
        edges: old.edgeCpu,
        nodeCount: old.nodeCount,
        edgeCount: old.edgeCount,
      });
      old.dispose();
      this.adopt(next);
      this.csrDirty = true;
      this.onCapacityGrow?.(nodeCap, edgeCap);
    } catch (err) {
      this.regrowFailed = true;
      console.error("GPU buffer regrow failed", err);
      this.onError?.(
        `The graph is larger than the GPU buffers and could not be resized: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.rebuilding = false;
    }
  }

  private adopt(gpu: GpuGraph): void {
    this.gpu = gpu;
    gpu.setDim(this.dim);
    gpu.setLook(this.dark);
    gpu.setEdgeOpacityScale(this.edgeOpacityScale);
    gpu.setArrowsVisible(this.arrowsOn);
    this.visibilityDirty = true;
    this.csrDirty = true;
  }

  /**
   * Auto-fit until the user interacts: positions are read back from the GPU (active
   * nodes only) every `fitIntervalMs` while simulating and once after the freeze; the
   * centroid and 95th-percentile radius give the target and distance, eased per frame.
   */
  private updateFit(now: number): void {
    const gpu = this.gpu;
    if (!this.fitting || !gpu || gpu.nodeCount === 0) return;
    const due =
      this.fitAfterFreeze ||
      (!this.fitValid && now - this.lastFitRead >= 200) ||
      (this.alpha > 0 && now - this.lastFitRead >= this.cfg.fitIntervalMs) ||
      this.lastFitRead === 0;
    if (due && !this.fitBusy && !this.rebuilding) {
      this.fitBusy = true;
      this.fitAfterFreeze = false;
      this.lastFitRead = now;
      const gen = this.generation;
      const count = gpu.nodeCount;
      gpu
        .readPositions(this.renderer, count)
        .then((pos) => {
          if (this.disposed || this.gpu !== gpu || gen !== this.generation) return;
          const fit = fitFromPositions(pos, count, 4, this.cfg.fitPercentile);
          const radius = Math.max(fit.radius + gpu.radius, this.cfg.rest); // include sphere size
          this.fitCenter.set(...fit.center);
          if (this.dim === 2) this.fitCenter.z = 0;
          this.fitDist = fitDistance(radius, FOV);
          this.fitValid = true;
          this.camera.near = Math.max(0.01, radius * 0.01);
          this.camera.far = Math.max(1000, (this.fitDist + radius) * 10);
          this.camera.updateProjectionMatrix();
          this.controls.maxDistance = this.fitDist * 20;
        })
        .catch((err: unknown) => console.warn("camera fit readback failed", err))
        .finally(() => (this.fitBusy = false));
    }
    const center = this.fitValid ? this.fitCenter : this.controls.target;
    const want = this.fitValid ? this.fitDist : this.estimateDist(gpu.nodeCount);
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length() || want;
    target.lerp(center, FIT_EASE);
    offset.setLength(dist + (want - dist) * FIT_EASE);
    this.camera.position.copy(target).add(offset);
  }
}
