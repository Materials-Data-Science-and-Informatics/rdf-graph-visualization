import * as THREE from "three/webgpu";
import type { GraphStore } from "@/lib/graph-store";
import { CameraRig } from "./camera-fit";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { GpuGraph } from "./gpu-graph";
import { GpuPicker } from "./gpu-picker";
import { StreamIngest, type CarrySnapshot } from "./ingest";
import { DEFAULT_CAPACITY, growCapacity, nextAlpha, roundCapacity } from "./layout-utils";
import { buildCarryMap, type PickHit } from "./picking";
import { PointerInput, type EngineHandlers } from "./pointer-input";
import { WebGpuUnavailableError, assertWebGpu, cssToRgb } from "./webgpu";

export type { EngineHandlers, PointerAt } from "./pointer-input";

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
  private readonly rig: CameraRig;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: CameraRig["controls"];
  private readonly resizeObs: ResizeObserver;
  private readonly themeObs: MutationObserver;
  private readonly ingest: StreamIngest;
  private readonly picker = new GpuPicker();
  private readonly input: PointerInput;

  private gpu: GpuGraph | null = null;
  private rebuilding = false;
  private regrowFailed = false;
  private failed = false;
  private disposed = false;
  private alpha: number;
  private dark = true;
  handlers: EngineHandlers = {};
  private selected: number | null = null;
  private edgeOpacityScale = 1;
  private arrowsOn = true;
  private curvedOn = true;
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
    this.ingest = new StreamIngest(cfg);

    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    this.rig = new CameraRig(canvas, cfg);
    this.camera = this.rig.camera;
    this.controls = this.rig.controls;

    this.input = new PointerInput(canvas, {
      handlers: () => this.handlers,
      pickAt: (x, y) => this.pickAt(x, y),
      focusOn: (i) => this.focusOn(i),
      generation: () => this.ingest.generation,
      releaseFocus: () => this.rig.releaseFocus(),
      applyHighlight: () => this.applyHighlight(),
    });
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
    this.ingest.attach(store);
  }

  setHandlers(h: EngineHandlers): void {
    this.handlers = h;
  }

  /** Highlight a node as selected (store index; null clears). */
  setSelected(index: number | null): void {
    this.selected = index;
    this.applyHighlight();
  }

  private applyHighlight(): void {
    const h = this.input.hoverHit;
    this.gpu?.setHighlight(
      h?.kind === "node" ? h.index : null,
      this.selected,
      h?.kind === "edge" ? h.index : null
    );
  }

  /**
   * Call right BEFORE restarting the stream with a new root: snapshots the current node
   * ids and reads their positions back (async); nodes of the next generation whose id was
   * present spawn at their old position. Nodes arriving before the readback resolves use
   * normal anchor placement.
   */
  captureForReroot(): void {
    const store = this.ingest.store;
    const gpu = this.gpu;
    if (!store || !gpu || gpu.nodeCount === 0) {
      this.ingest.snapshot = null;
      return;
    }
    const ids = store.nodeIds.slice(0, gpu.nodeCount);
    const entry: CarrySnapshot = { map: null, failed: false };
    this.ingest.snapshot = entry;
    gpu
      .readPositions(this.renderer, ids.length)
      .then((pos) => {
        entry.map = buildCarryMap(ids, pos);
      })
      .catch((err: unknown) => {
        console.warn("position carry-over readback failed", err);
        entry.failed = true;
      });
  }

  /** Smoothly move the orbit target to node `index` (and zoom in if far away). */
  focusOn(index: number): void {
    const gpu = this.gpu;
    if (!gpu || index < 0 || index >= gpu.nodeCount) return;
    gpu
      .readNode(this.renderer, index)
      .then(([x, y, z]) => {
        if (this.disposed || this.gpu !== gpu) return;
        this.rig.focusPoint(x, y, z);
      })
      .catch((err: unknown) => console.warn("focus readback failed", err));
  }

  /**
   * Hide/show all nodes of a group (-1 = unclassified). Hidden nodes and edges touching
   * them are not drawn; the layout keeps simulating them.
   */
  setGroupVisible(groupIndex: number, visible: boolean): void {
    if (visible) this.ingest.hidden.delete(groupIndex);
    else this.ingest.hidden.add(groupIndex);
    this.ingest.visibilityDirty = true;
  }

  /** Multiplier on the automatic edge opacity (1 = default). */
  setEdgeOpacityScale(scale: number): void {
    this.edgeOpacityScale = scale;
    this.gpu?.setEdgeOpacityScale(scale);
  }

  setCurved(on: boolean): void {
    this.curvedOn = on;
    this.gpu?.setCurved(on);
  }

  setArrowsVisible(on: boolean): void {
    this.arrowsOn = on;
    this.gpu?.setArrowsVisible(on);
  }

  /**
   * 2D = z locked via uniform; camera looks straight down -z and left-drag pans (map-like).
   * Switching re-runs the layout at full strength with every node mobile: a 3D layout
   * squashed flat overlaps heavily and needs room to spread (and vice versa).
   */
  setDim(dim: 2 | 3): void {
    const changed = dim !== this.rig.dim;
    this.rig.applyDim(dim);
    this.gpu?.setDim(dim);
    if (changed) {
      this.gpu?.setSettled(0);
      this.alpha = this.cfg.alphaStart;
      this.rig.fitAfterFreeze = false;
    }
    this.resetView();
  }

  /** Re-frame the whole graph and resume auto-fit while the graph grows. */
  resetView(): void {
    this.rig.resetView();
  }

  /**
   * Show only the first `n` nodes (store indices are in BFS arrival order) and the edges
   * among them, client-side from already loaded data. Re-heats the layout.
   */
  setNodeLimit(n: number): void {
    if (n === this.ingest.windowN) return;
    this.ingest.windowN = n;
    this.ingest.windowDirty = true;
    this.rig.lastFitRead = 0; // re-fit if still auto-fitting
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
    this.input.dispose();
    this.picker.dispose();
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

  /** Relation IRI -> CSS colour (config order palette); set by the UI. */
  setRelationColors(colors: ReadonlyMap<string, string>): void {
    this.ingest.setRelationColors(colors);
  }

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
          if (this.alpha === 0) this.rig.fitAfterFreeze = true;
        }
      }
    }
    this.rig.updateFit(now, {
      gpu: this.gpu,
      renderer: this.renderer,
      alpha: this.alpha,
      rebuilding: this.rebuilding,
      generation: this.ingest.generation,
      isCurrent: (gpu, gen) => !this.disposed && this.gpu === gpu && gen === this.ingest.generation,
    });
    this.rig.updateFocus();
    this.rig.updateClip(this.gpu);
    this.controls.update();
    void this.renderer.render(this.scene, this.camera);
    this.input.tick(now);
  }

  /** GPU pick at client position (see GpuPicker); null when the graph changed meanwhile. */
  private pickAt(clientX: number, clientY: number): Promise<PickHit | null> {
    const gpu = this.gpu;
    if (!gpu || gpu.nodeCount === 0 || this.failed || this.disposed) return Promise.resolve(null);
    const gen = this.ingest.generation;
    return this.picker
      .pick(this.renderer, this.camera, gpu, clientX, clientY)
      .then((hit) =>
        this.disposed || this.gpu !== gpu || this.ingest.generation !== gen ? null : hit
      );
  }

  /** Apply store deltas to the GPU (partial uploads only; existing nodes keep simulating). */
  private pull(now: number): void {
    const store = this.ingest.store;
    if (!store) return;
    if (store.generation !== this.ingest.generation) this.resetGeneration(store);
    if (store.nodeCount === 0 && store.edgeCount === 0) return;

    if (!this.ensureCapacity(store)) return; // async regrow in flight; deltas stay queued in the store
    const gpu = this.gpu;
    if (!gpu) return;
    this.alpha = Math.max(this.alpha, this.ingest.apply(gpu, store, now, this.rig));
  }

  private resetGeneration(store: GraphStore): void {
    this.onGenerationReset?.(this.gpu?.nodeCount ?? 0);
    this.selected = null;
    this.input.clearHover();
    const hadSnapshot = this.ingest.snapshot !== null;
    this.ingest.reset(store.generation);
    this.gpu?.clear();
    this.regrowFailed = false;
    this.gpu?.reseed();
    this.alpha = this.cfg.alphaStart;
    this.rig.resetForGeneration(hadSnapshot);
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
      this.ingest.gpuReplaced();
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
        edgeStore: old.edgeStoreCpu,
        edgeColors: old.edgeColorCpu,
        nodeCount: old.nodeCount,
        edgeCount: old.edgeCount,
      });
      old.dispose();
      this.adopt(next);
      this.ingest.csrDirty = true;
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
    gpu.setDim(this.rig.dim);
    gpu.setLook(this.dark);
    gpu.setEdgeOpacityScale(this.edgeOpacityScale);
    gpu.setArrowsVisible(this.arrowsOn);
    gpu.setCurved(this.curvedOn);
    this.applyHighlight();
    this.ingest.visibilityDirty = true;
    this.ingest.csrDirty = true;
  }
}
