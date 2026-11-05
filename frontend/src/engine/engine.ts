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
import {
  CLICK_MAX_MOVE_PX,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
  TOUCH_TAP_MAX_MS,
  buildCarryMap,
  choosePick,
  classifyPointer,
  type PickHit,
  type PointerSample,
  type Vec3,
} from "./picking";
import { WebGpuUnavailableError, assertWebGpu, cssToRgb } from "./webgpu";

/** Client-space pointer position. */
export interface PointerAt {
  x: number;
  y: number;
}

/**
 * Picking callbacks. `hit` is null over empty space; node hits carry the store index.
 * `onClick` = left click / tap, `onContextMenu` = right click / long-press.
 */
export interface EngineHandlers {
  onHover?: (hit: PickHit | null, at: PointerAt) => void;
  onClick?: (hit: PickHit | null, at: PointerAt) => void;
  onContextMenu?: (hit: PickHit | null, at: PointerAt) => void;
}

/** Previous graph's node ids + (async) positions, for re-root position carry-over. */
interface CarrySnapshot {
  map: Map<string, Vec3> | null;
  failed: boolean;
}
const CARRY_WAIT_MS = 300;
const PICK_N = 9; // pick window (device px): +-4 px around the pointer
const HOVER_INTERVAL_MS = 33;
const LONG_PRESS_MS = 600;

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
  /** Camera distance never drops below this until the final (post-freeze) fit; avoids zoom oscillation. */
  private distFloor = 0;
  /** After a re-root: keep the orbit target on the (carried) root until the final fit. */
  private anchored = false;
  private anchorPending = false;
  private viewDir = new THREE.Vector3(0, 0, 1);
  handlers: EngineHandlers = {};
  private readonly pickRT = new THREE.RenderTarget(PICK_N, PICK_N, {
    depthBuffer: true,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });
  private readonly pickSize = new THREE.Vector2();
  private readonly pickClear = new THREE.Color();
  private hoverHit: PickHit | null = null;
  private hoverPos: PointerAt | null = null; // client coords of the latest pointer move
  private hoverDirty = false;
  private hoverBusy = false;
  private lastHoverPick = 0;
  private selected: number | null = null;
  private down: (PointerSample & { button: number; touch: boolean }) | null = null;
  private readonly pointers = new Set<number>();
  private longTimer: ReturnType<typeof setTimeout> | undefined;
  private longFired = false;
  private readonly unbind: (() => void)[] = [];
  /** Positions of the previous graph for a re-root (see captureForReroot). */
  private snapshot: CarrySnapshot | null = null; // taken by captureForReroot, consumed by resetGeneration
  private carry: { entry: CarrySnapshot; generation: number; since: number } | null = null;
  private focusTarget: THREE.Vector3 | null = null;
  private focusDist = 0;
  /** Graph radius (world units) used for the clip planes and zoom limits; refined by the fit. */
  private graphRadius = 0;
  private readonly hidden = new Set<number>(); // hidden group indices (-1 = unclassified)
  private visibilityDirty = false;
  private visibilityStale = false;
  private lastVisibility = 0;
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

    this.bindPointer(canvas);

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
    this.handlers = h;
  }

  /** Highlight a node as selected (store index; null clears). */
  setSelected(index: number | null): void {
    this.selected = index;
    this.applyHighlight();
  }

  private applyHighlight(): void {
    const h = this.hoverHit;
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
    const store = this.store;
    const gpu = this.gpu;
    if (!store || !gpu || gpu.nodeCount === 0) {
      this.snapshot = null;
      return;
    }
    const ids = store.nodeIds.slice(0, gpu.nodeCount);
    const entry: CarrySnapshot = { map: null, failed: false };
    this.snapshot = entry;
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
        this.fitting = false;
        this.focusTarget = new THREE.Vector3(x, y, this.dim === 2 ? 0 : z);
        this.focusDist = Math.min(
          this.camera.position.distanceTo(this.controls.target),
          this.cfg.rest * 6
        );
      })
      .catch((err: unknown) => console.warn("focus readback failed", err));
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

  setCurved(on: boolean): void {
    this.curvedOn = on;
    this.gpu?.setCurved(on);
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
    this.distFloor = 0;
    this.anchored = false;
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
    clearTimeout(this.longTimer);
    this.unbind.forEach((u) => u());
    this.pickRT.dispose();
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
    this.updateFocus();
    this.updateClip();
    this.controls.update();
    void this.renderer.render(this.scene, this.camera);
    if (this.hoverDirty && !this.hoverBusy && now - this.lastHoverPick >= HOVER_INTERVAL_MS) {
      this.hoverDirty = false;
      this.lastHoverPick = now;
      this.pickHover();
    }
  }

  /**
   * Clip planes and zoom limits follow the current zoom every frame (fixed planes blacked
   * out the graph when zooming in past `near` or out past `far`).
   */
  private updateClip(): void {
    const nodeR = this.gpu?.radius ?? this.cfg.rest / 6;
    const radius = Math.max(this.graphRadius, this.estimateDist(1) / 4, nodeR * 4);
    const dist = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.05, dist * 0.002);
    const far = dist + radius * 4;
    this.controls.minDistance = nodeR * 1.5;
    this.controls.maxDistance = Math.max(radius * 20, dist);
    const c = this.camera;
    if (Math.abs(near - c.near) > c.near * 0.05 || Math.abs(far - c.far) > c.far * 0.05) {
      c.near = near;
      c.far = far;
      c.updateProjectionMatrix();
    }
  }

  /** Ease the orbit target (camera shifts with it) towards `focusTarget`. */
  private updateFocus(): void {
    const t = this.focusTarget;
    if (!t) return;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length() || this.focusDist;
    target.lerp(t, 0.12);
    offset.setLength(dist + (this.focusDist - dist) * 0.12);
    this.camera.position.copy(target).add(offset);
    if (
      target.distanceTo(t) < 1e-2 * Math.max(1, this.focusDist) &&
      Math.abs(dist - this.focusDist) < 1e-2 * this.focusDist
    ) {
      this.focusTarget = null;
    }
  }

  // ---- picking -----------------------------------------------------------------

  /**
   * GPU pick at client position: renders the id twins of the nodes/edges into a 9x9 target
   * (camera view offset = the window around the pointer, so only ~81 fragments are shaded;
   * vertex work equals one cheap extra frame of the instanced draws), then reads the 324
   * bytes back asynchronously. Resolves with the nearest node, else the nearest edge.
   */
  private pickAt(clientX: number, clientY: number): Promise<PickHit | null> {
    const gpu = this.gpu;
    if (!gpu || gpu.nodeCount === 0 || this.failed || this.disposed) return Promise.resolve(null);
    const gen = this.generation;
    const nodes = gpu.nodeCount;
    const edges = gpu.edgeCount;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.renderer.getDrawingBufferSize(this.pickSize);
    const sx = this.pickSize.x / Math.max(1, rect.width);
    const sy = this.pickSize.y / Math.max(1, rect.height);
    const px = Math.floor((clientX - rect.left) * sx);
    const py = Math.floor((clientY - rect.top) * sy);
    const r = this.renderer;
    const half = (PICK_N - 1) / 2;
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.pickClear);
    const prevRT = r.getRenderTarget();
    this.camera.setViewOffset(
      this.pickSize.x,
      this.pickSize.y,
      px - half,
      py - half,
      PICK_N,
      PICK_N
    );
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.pickRT);
    try {
      void r.render(gpu.pickScene, this.camera);
    } finally {
      r.setRenderTarget(prevRT);
      r.setClearColor(this.pickClear, prevAlpha);
      this.camera.clearViewOffset();
    }
    return r.readRenderTargetPixelsAsync(this.pickRT, 0, 0, PICK_N, PICK_N).then((buf) => {
      if (this.disposed || this.gpu !== gpu || this.generation !== gen) return null;
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

  private pickHover(): void {
    const at = this.hoverPos;
    if (!at) return;
    this.hoverBusy = true;
    const gen = this.generation;
    this.pickAt(at.x, at.y)
      .then((hit) => {
        if (gen !== this.generation || !this.hoverPos) return;
        const prev = this.hoverHit;
        const same = prev?.kind === hit?.kind && prev?.index === hit?.index;
        if (same && hit) return;
        if (!hit && !prev) return;
        this.hoverHit = hit;
        this.applyHighlight();
        this.handlers.onHover?.(hit, this.hoverPos ?? at);
      })
      .catch((err: unknown) => console.warn("pick failed", err))
      .finally(() => (this.hoverBusy = false));
  }

  private clearHover(): void {
    this.hoverDirty = false;
    this.hoverPos = null;
    if (!this.hoverHit) return;
    this.hoverHit = null;
    this.applyHighlight();
    this.handlers.onHover?.(null, { x: 0, y: 0 });
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void
    ) => {
      canvas.addEventListener(type, fn);
      this.unbind.push(() => canvas.removeEventListener(type, fn));
    };
    const cancelLong = () => clearTimeout(this.longTimer);
    let lastTap: PointerSample | null = null;
    const resetPointers = () => {
      this.pointers.clear();
      this.down = null;
      cancelLong();
    };
    window.addEventListener("blur", resetPointers);
    this.unbind.push(() => window.removeEventListener("blur", resetPointers));
    on("lostpointercapture", (e) => this.pointers.delete(e.pointerId));
    on("wheel", () => (this.focusTarget = null));
    const sample = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: performance.now() });
    const fire = (kind: "onClick" | "onContextMenu", at: PointerAt) =>
      void this.pickAt(at.x, at.y)
        .then((hit) => this.handlers[kind]?.(hit, at))
        .catch((err: unknown) => console.warn("pick failed", err));

    on("pointerdown", (e) => {
      this.pointers.add(e.pointerId);
      this.focusTarget = null; // user takes over the camera
      this.clearHover();
      cancelLong();
      if (this.pointers.size > 1) {
        this.down = null; // multi-touch = camera gesture
        return;
      }
      this.down = { ...sample(e), button: e.button, touch: e.pointerType === "touch" };
      this.longFired = false;
      if (e.pointerType === "touch") {
        const at = { x: e.clientX, y: e.clientY };
        this.longTimer = setTimeout(() => {
          if (!this.down) return;
          this.longFired = true;
          fire("onContextMenu", at);
        }, LONG_PRESS_MS);
      }
    });
    on("pointermove", (e) => {
      if (this.down) {
        if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > CLICK_MAX_MOVE_PX) {
          cancelLong();
        }
        return;
      }
      if (e.pointerType === "touch" || e.buttons !== 0) return;
      this.hoverPos = { x: e.clientX, y: e.clientY };
      this.hoverDirty = true;
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      cancelLong();
      const d = this.down;
      this.down = null;
      if (!d) return;
      if (this.longFired || e.type === "pointercancel") return;
      const up = sample(e);
      if (
        classifyPointer(d, up, CLICK_MAX_MOVE_PX, d.touch ? TOUCH_TAP_MAX_MS : Infinity) !== "click"
      )
        return;
      const at = { x: e.clientX, y: e.clientY };
      if (d.touch && d.button === 0) {
        const prev = lastTap;
        if (
          prev &&
          up.t - prev.t <= DOUBLE_TAP_MS &&
          Math.hypot(up.x - prev.x, up.y - prev.y) <= DOUBLE_TAP_PX
        ) {
          lastTap = null;
          void this.pickAt(at.x, at.y).then((hit) => {
            if (hit?.kind === "node") this.focusOn(hit.index);
          });
        } else lastTap = up;
      }
      if (d.button === 0) fire("onClick", at);
      else if (d.button === 2) fire("onContextMenu", at);
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("pointerleave", () => this.clearHover());
    on("contextmenu", (e) => e.preventDefault());
    on("dblclick", (e) => {
      void this.pickAt(e.clientX, e.clientY).then((hit) => {
        if (hit?.kind === "node") this.focusOn(hit.index);
      });
    });
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

    if (this.carry && store.generation !== this.carry.generation) this.carry = null;
    let carry: Map<string, Vec3> | null = null;
    if (this.carry) {
      const { entry, since } = this.carry;
      if (entry.map) {
        carry = entry.map;
        if (this.anchorPending && store.nodeCount > 0) {
          this.anchorPending = false;
          const root = entry.map.get(store.nodeIds[0]);
          if (root && this.fitting) {
            this.anchored = true;
            this.fitCenter.set(...root);
            if (this.dim === 2) this.fitCenter.z = 0;
          }
        }
      } else if (entry.failed || now - since >= CARRY_WAIT_MS) this.carry = null;
      else return; // readback pending: hold the new nodes back (they stay queued in the store)
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
      gpu.rescanEdges(store);
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
    this.onGenerationReset?.(this.gpu?.nodeCount ?? 0);
    this.generation = store.generation;
    this.selected = null;
    this.clearHover();
    this.focusTarget = null;
    const snap = this.snapshot;
    this.snapshot = null;
    this.carry = snap
      ? { entry: snap, generation: store.generation, since: performance.now() }
      : null;
    this.gpu?.clear();
    this.csrDirty = false;
    this.regrowFailed = false;
    this.fitValid = false;
    this.edgesScanned = 0;
    this.windowDirty = false;
    this.gpu?.reseed();
    this.alpha = this.cfg.alphaStart;
    // Keep the orbit direction and distance (no jump): the fit only grows the distance while
    // streaming, optionally anchored on the carried root, with one final fit at freeze.
    this.fitting = true;
    this.fitAfterFreeze = false;
    this.lastFitRead = 0;
    this.anchored = false;
    this.anchorPending = snap !== null;
    this.distFloor = this.camera.position.distanceTo(this.controls.target);
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
        edgeStore: old.edgeStoreCpu,
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
    gpu.setCurved(this.curvedOn);
    this.applyHighlight();
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
      const final = this.fitAfterFreeze;
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
          let center: Vec3 = fit.center;
          let r = radius;
          if (final) this.anchored = false;
          if (this.anchored) {
            // frame the graph around the root: radius grows by the root-to-centroid offset
            center = [pos[0], pos[1], pos[2]];
            r += Math.hypot(
              center[0] - fit.center[0],
              center[1] - fit.center[1],
              center[2] - fit.center[2]
            );
          }
          this.fitCenter.set(...center);
          if (this.dim === 2) this.fitCenter.z = 0;
          const d = fitDistance(r, FOV);
          const base = this.fitValid ? this.fitDist : this.distFloor;
          this.fitDist = final ? d : Math.max(d, base);
          this.fitValid = true;
          this.graphRadius = radius;
        })
        .catch((err: unknown) => console.warn("camera fit readback failed", err))
        .finally(() => (this.fitBusy = false));
    }
    const center = this.fitValid || this.anchored ? this.fitCenter : this.controls.target;
    const want = this.fitValid
      ? this.fitDist
      : Math.max(this.estimateDist(gpu.nodeCount), this.distFloor);
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length() || want;
    target.lerp(center, FIT_EASE);
    offset.setLength(dist + (want - dist) * FIT_EASE);
    this.camera.position.copy(target).add(offset);
  }
}
