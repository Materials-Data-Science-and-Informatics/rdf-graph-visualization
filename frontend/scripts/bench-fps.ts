// Card D5 — fps benchmark harness (browser side).
//
// Bundled for the browser by scripts/bench-fps.mjs (esbuild IIFE) and loaded
// into a real headless Chromium (SwiftShader software GL). It measures the
// interactive frame rate of the three renderers the app supports, on the
// committed QLever-dev fixtures (5k / 25k nodes):
//
//   fgraph3d — the app's CURRENT 3D view: react-force-graph-3d (three.js)
//              with d3-force layout, mounted through the same React
//              component with the same props as src/components/Graph.tsx;
//   sigma    — the D2 sigma v3 2D adapter (canvas renderer + force-atlas2
//              layout in its own Worker, injected from a blob so the
//              IIFE bundle works outside Vite);
//   cosmos   — the D3 cosmos.gl 2D GPU adapter (static seeded positions,
//              camera driven by a synthetic circular mouse drag — d3-drag
//              3.0.0, which is what cosmos.gl's input layer is).
//
// Protocol (per renderer, per fixture size):
//   1. set the fixture graph, time the first non-blank frame;
//   2. settle: let the layout run (d3 simulation / FA2 worker) until it
//      cools or the settle cap is hit, then stop it and fit the view;
//   3. measure: a fixed window (default 10 s) of CONTINUOUS scripted
//      camera motion (a slow orbit / pan so every frame does real work),
//      counting requestAnimationFrame frames;
//   4. publish window.__BENCH_RESULT__ for the driver.
//
// The rAF count is the user-visible frame rate: when a renderer's per-frame
// work (JS + software GL draw) exceeds the frame budget, frames are late and
// the measured fps drops. A canvas pixel-diff across the window proves
// motion actually happened (motionPx), so a stalled scene can never read
// as fast.

import * as React from "react";
import { createRoot } from "react-dom/client";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";
import { getGroupColor, loadConfig } from "../src/config";
import type { CosmosRenderer } from "../src/render/cosmos";
import { createCosmosRenderer } from "../src/render/cosmos";
import type { LayoutRequest, LayoutTick, LayoutWorkerClient } from "../src/render/layout-worker";
import type { RendererGraph } from "../src/render/renderer";
import type { SigmaRenderer } from "../src/render/sigma";
import { createSigmaRenderer } from "../src/render/sigma";

// ---- options / fixture ------------------------------------------------------

type BenchRenderer = "fgraph3d" | "sigma" | "cosmos";

interface BenchOptions {
  renderer: BenchRenderer;
  /** Measurement window length (ms). Default 10000. */
  measureMs?: number;
  /** For slow (sub-Hz) renderers: extend the window up to this (ms). */
  measureMaxMs?: number;
  /** Layout-settle cap (ms). Default 120000. */
  settleCapMs?: number;
  /** One full orbit/pan cycle (ms). Default 4000. */
  orbitPeriodMs?: number;
  /** Sigma FA2 total iterations (diagnostic knob; default = adapter default). */
  layoutIterations?: number;
  width?: number;
  height?: number;
}

interface FixtureNode {
  id: string;
  label: string;
  group: string;
}
interface FixtureLink {
  source: string;
  target: string;
  label: string;
}
interface Fixture {
  nodes: FixtureNode[];
  links: FixtureLink[];
}

interface BenchResult {
  renderer: BenchRenderer;
  nodes: number;
  links: number;
  /** true when the adapter ran without a GL/canvas engine (failure). */
  headless: boolean;
  /** ms from set() to the first non-blank canvas frame (-1 = never). */
  firstFrameMs: number;
  /** ms from set() to a cooled layout (or the settle cap). */
  settleMs: number;
  /** true when the layout actually cooled (not capped). */
  settled: boolean;
  windowMs: number;
  frameCount: number;
  fpsMean: number;
  fpsMedian: number;
  fpsMin: number;
  /** frame-interval percentiles in ms. */
  frameMsP50: number;
  frameMsP90: number;
  /** canvas pixels that changed across the window (motion proof, 1/8 stride). */
  motionPx: number;
  error?: string;
}

const options: BenchOptions = (window as unknown as { __BENCH_OPTIONS__?: BenchOptions })
  .__BENCH_OPTIONS__ ?? {
  renderer: "cosmos",
};
const rendererId: BenchRenderer = options.renderer ?? "cosmos";
const MEASURE_MS = options.measureMs ?? 10000;
/** fgraph3d under SwiftShader can render sub-Hz: extend its window until it
 * produces at least MIN_FRAMES frames (so fps is not a single-frame fluke). */
const MEASURE_MAX_MS = options.measureMaxMs ?? 240000;
const MIN_FRAMES = 5;
/** Page-time budget for "wait for first non-blank frame". A fixed iteration
 * cap alone is not a time cap: under main-thread starvation (heavy software
 * GL) each 100 ms timer can take seconds of wall time. */
const FIRST_FRAME_BUDGET_MS = 90000;
const SETTLE_CAP_MS = options.settleCapMs ?? 120000;
const ORBIT_PERIOD_MS = options.orbitPeriodMs ?? 4000;
const WIDTH = options.width ?? 800;
const HEIGHT = options.height ?? 600;

const fixture: Fixture = (window as unknown as { __BENCH_FIXTURE__: Fixture }).__BENCH_FIXTURE__;

// ---- headless input shim ------------------------------------------------------
// d3-drag (cosmos.gl's input layer) may call pointer capture with the
// synthetic event's id, which throws for events without a real pointer
// behind them. The no-op capture/release changes input BOOKKEEPING only —
// never rendering — and exists so the scripted drag can run in headless.
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;

// ---- shared helpers -----------------------------------------------------------

const container = document.createElement("div");
container.style.cssText = `position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:#000;`;
document.body.appendChild(container);

// Node styling shared by the fgraph3d probe — same shapes as Graph.tsx.
const boxGeometry = new THREE.BoxGeometry(8, 8, 8);
const sphereGeometry = new THREE.SphereGeometry(5);
const materialCache = new Map<string, THREE.Material>();

function toRendererGraph(): RendererGraph {
  return {
    nodes: fixture.nodes.map((n) => ({ id: n.id, label: n.label, group: n.group })),
    links: fixture.links.map((l, i) => ({
      id: `l-${i}`,
      source: l.source,
      target: l.target,
      label: l.label,
    })),
  };
}

interface CanvasSample {
  canvas: boolean;
  w: number;
  h: number;
  px: number;
  data?: Uint8ClampedArray;
}

function sampleCanvas(): CanvasSample {
  const canvas = container.querySelector("canvas");
  if (!canvas) return { canvas: false, w: 0, h: 0, px: 0 };
  const el = canvas as HTMLCanvasElement;
  const w = el.width;
  const h = el.height;
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d");
  if (!ctx) return { canvas: true, w, h, px: 0 };
  ctx.drawImage(el, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30) count++;
  }
  return { canvas: true, w, h, px: count, data };
}

/** Pixels that differ between two samples (1/8 stride — enough to prove motion). */
function pixelsChanged(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (!a || !b || a.length !== b.length) return 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 32) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
  }
  return changed;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const log = (s: string): void => {
  console.log(`[bench] ${s}`);
};

interface WindowStats {
  windowMs: number;
  frameCount: number;
  fpsMean: number;
  fpsMedian: number;
  fpsMin: number;
  frameMsP50: number;
  frameMsP90: number;
  motionPx: number;
}

/**
 * Sample the canvas inside a rAF batch. With preserveDrawingBuffer:false
 * (WebGL renderers) the backbuffer is only valid DURING the frame — a
 * timer-driven sample runs between frames and reads a cleared buffer.
 * rAF callbacks run after the library's render callback, before composite.
 */
function sampleInRAF(): Promise<CanvasSample> {
  return new Promise<CanvasSample>((resolve) => {
    window.requestAnimationFrame(() => resolve(sampleCanvas()));
  });
}

/**
 * Frame counter + camera driver: one rAF loop for the whole measurement
 * window. `drive(dtMs)` moves the camera (renderer-specific). Returns fps
 * statistics plus a motion proof (canvas diff, window start vs 80% mark).
 *
 * `opts.extendMs` + `opts.minFrames` (slow renderers only): when the base
 * window ends with fewer than minFrames frames, keep going (in 30 s steps)
 * up to opts.extendMs so a sub-Hz renderer still yields a real fps.
 */
async function measureWindow(
  drive: (dtMs: number) => void,
  opts: { extendMs?: number; minFrames?: number } = {}
): Promise<WindowStats> {
  const stamps: number[] = [];
  const startAt = performance.now();
  let endAt = startAt + MEASURE_MS;
  let motionBase: Uint8ClampedArray | null = null;
  let motionLate: Uint8ClampedArray | null = null;
  let motionMark = startAt + MEASURE_MS * 0.8;
  await new Promise<void>((resolve) => {
    let last = startAt;
    const step = (now: number): void => {
      const dt = now - last;
      last = now;
      stamps.push(now);
      drive(dt);
      if (motionBase === null) motionBase = sampleCanvas().data ?? null;
      if (motionLate === null && now >= motionMark) {
        motionLate = sampleCanvas().data ?? null;
      }
      if (
        now < endAt ||
        (opts.extendMs !== undefined &&
          now < startAt + opts.extendMs &&
          stamps.length < (opts.minFrames ?? 0))
      ) {
        if (now >= endAt) {
          // slow renderer: extend the window one 30 s step
          endAt = Math.min(endAt + 30000, startAt + (opts.extendMs ?? MEASURE_MS));
          motionMark = Math.max(motionMark, startAt + (endAt - startAt) * 0.8);
        }
        window.requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    window.requestAnimationFrame(step);
  });
  const windowMs = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
  const gaps: number[] = [];
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i] - stamps[i - 1]);
  gaps.sort((a, b) => a - b);
  // 1-second fps buckets (the user-perceived "worst second" matters).
  const buckets = new Map<number, number>();
  for (const s of stamps) {
    const b = Math.floor((s - stamps[0]) / 1000);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const bucketFps = [...buckets.values()].sort((a, b) => a - b);
  const fpsValues = bucketFps.length > 0 ? bucketFps : [0];
  return {
    windowMs: Math.round(windowMs),
    frameCount: stamps.length,
    fpsMean: Math.round((stamps.length / (windowMs / 1000)) * 100) / 100,
    fpsMedian: percentile(fpsValues, 0.5),
    fpsMin: fpsValues[0],
    frameMsP50: Math.round(percentile(gaps, 0.5) * 100) / 100,
    frameMsP90: Math.round(percentile(gaps, 0.9) * 100) / 100,
    motionPx: pixelsChanged(
      motionBase ?? new Uint8ClampedArray(0),
      motionLate ?? new Uint8ClampedArray(0)
    ),
  };
}

// ---- the three renderers ------------------------------------------------------

/**
 * The app's current 3D view, verbatim: the SAME ForceGraph3D component with
 * the SAME props as src/components/Graph.tsx (node spheres/boxes, link look,
 * d3 tuning, background). The probe hands the ForceGraphMethods ref out once
 * it is attached (commit phase, after the first render).
 *
 * The library's d.ts is stale (its ref generic + missing graphData
 * declaration don't match the shipped 1.29.2 runtime), so the component is
 * mounted through a plain ComponentType — same component, same props object.
 */
const fg3dComponent = ForceGraph3D as unknown as React.ComponentType<Record<string, unknown>>;

function FgProbe(props: {
  graphData: {
    nodes: { id: string; label: string; group: string }[];
    links: { id: string; source: string; target: string; label: string }[];
  };
  width: number;
  height: number;
  onReady: (fg: ForceGraphMethods) => void;
  onEngineStopped?: () => void;
}): React.ReactElement {
  const { onReady, onEngineStopped, graphData, width, height } = props;
  const ref = React.useRef<ForceGraphMethods | undefined>(undefined);
  React.useEffect(() => {
    if (ref.current !== undefined) onReady(ref.current);
  }, [onReady, ref]);
  return React.createElement(fg3dComponent, {
    ref,
    graphData,
    width,
    height,
    onEngineStop: onEngineStopped,
    linkDirectionalArrowLength: 7,
    linkDirectionalArrowRelPos: 1,
    linkCurvature: 0.3,
    linkOpacity: 0.5,
    linkWidth: 5,
    backgroundColor: "#000000",
    nodeThreeObject: (node: { group?: string }) => {
      const group = node.group ?? "";
      const geometry = group === "" ? boxGeometry : sphereGeometry;
      const color = getGroupColor(group);
      let material = materialCache.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
        materialCache.set(color, material);
      }
      return new THREE.Mesh(geometry, material);
    },
    d3AlphaDecay: 0.02,
    d3VelocityDecay: 0.3,
    enableNodeDrag: true,
    enableNavigationControls: true,
    showNavInfo: false,
  });
}

async function benchFgraph3d(result: BenchResult): Promise<void> {
  const host = document.createElement("div");
  host.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;`;
  container.appendChild(host);
  const root = createRoot(host);

  const startedAt = performance.now();
  let firstFrameMs = -1;
  const holder: { fg: ForceGraphMethods | null } = { fg: null };
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const onReady = (instance: ForceGraphMethods): void => {
    holder.fg = instance;
    resolveReady();
  };

  const graphData = {
    nodes: fixture.nodes.map((n) => ({ id: n.id, label: n.label, group: n.group })),
    links: fixture.links.map((l, i) => ({
      id: `l-${i}`,
      source: l.source,
      target: l.target,
      label: l.label,
    })),
  };
  // The engine's cool-down signal, wired through the library's onEngineStop
  // PROP (the callback-registration method exists at runtime on the kapsule
  // instance but the shipped d.ts omits it from ForceGraphMethods).
  let resolveEngineStop: (v: boolean) => void = () => undefined;
  const engineStop = new Promise<boolean>((resolve) => {
    resolveEngineStop = resolve;
  });
  root.render(
    React.createElement(FgProbe, {
      graphData,
      width: WIDTH,
      height: HEIGHT,
      onReady,
      onEngineStopped: () => resolveEngineStop(true),
    })
  );
  await ready;
  const fg = holder.fg;
  if (!fg) throw new Error("fgraph3d ref never attached");
  result.headless = false;

  // first non-blank frame (page-time budget; sampled inside rAF batches so a
  // preserveDrawingBuffer:false WebGL canvas is read while its backbuffer is
  // still valid)
  for (
    let i = 0;
    i < 600 && firstFrameMs < 0 && performance.now() - startedAt < FIRST_FRAME_BUDGET_MS;
    i++
  ) {
    const sample = await sampleInRAF();
    if (sample.canvas && sample.px > 500) firstFrameMs = Math.round(performance.now() - startedAt);
  }
  if (firstFrameMs < 0) log("fgraph3d: first-frame budget exhausted (no non-blank frame seen)");
  result.firstFrameMs = firstFrameMs;

  // settle: wait for the engine's own cool-down (onEngineStop — the d3
  // simulation handle is not exposed by 3d-force-graph 1.80), or the cap.
  const settleStart = performance.now();
  log("fgraph3d: waiting for d3 engine to cool (onEngineStop)");
  const cap = new Promise<boolean>((resolve) => {
    const poll = (): void => {
      if (performance.now() - settleStart >= SETTLE_CAP_MS) resolve(false);
      else window.requestAnimationFrame(poll);
    };
    window.requestAnimationFrame(poll);
  });
  const settled = await Promise.race([engineStop, cap]);
  result.settleMs = Math.round(performance.now() - settleStart);
  result.settled = settled;
  log(`fgraph3d: settle done ${result.settleMs}ms (cooled=${settled})`);
  if (!settled) log("fgraph3d: engine still running at cap — measure window includes live layout");

  fg.zoomToFit(300, 60);
  await wait(800);

  // orbit: circular camera path around the d3-settled node cloud (bbox from
  // the typed API).
  const bbox = fg.getGraphBbox();
  const cx = (bbox.x[0] + bbox.x[1]) / 2;
  const cy = (bbox.y[0] + bbox.y[1]) / 2;
  const cz = (bbox.z[0] + bbox.z[1]) / 2;
  const radius = Math.max(bbox.x[1] - bbox.x[0], bbox.y[1] - bbox.y[0], bbox.z[1] - bbox.z[0]) / 2;
  const R = Math.max(radius * 1.4, 1);
  let theta = 0;
  const stats = await measureWindow(
    (dtMs) => {
      theta += (2 * Math.PI * dtMs) / ORBIT_PERIOD_MS;
      const cam = {
        x: cx + R * Math.cos(theta) * 0.866,
        y: cy + R * 0.5,
        z: cz + R * Math.sin(theta) * 0.866,
      };
      const look = { x: cx, y: cy, z: cz };
      fg?.cameraPosition(cam, look, 0);
      // The render loop (3d-force-graph _animationCycle) runs continuously and
      // redraws every rAF — no manual redraw call needed.
    },
    // Sub-Hz under SwiftShader: extend until ≥MIN_FRAMES frames (max 4 min)
    // so the fps is a rate, not a one-frame fluke.
    { extendMs: MEASURE_MAX_MS, minFrames: MIN_FRAMES }
  );
  Object.assign(result, stats);
  root.unmount();
}

/** Blob-backed LayoutWorkerClient speaking the exact message protocol of
 * src/render/layout-worker.ts (the adapter's injected-worker seam). */
function makeBlobWorkerClient(): LayoutWorkerClient {
  const src = (window as unknown as { __BENCH_WORKER_SRC__: string }).__BENCH_WORKER_SRC__;
  const blob = new Blob([src], { type: "text/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));
  const tickListeners = new Set<(tick: LayoutTick) => void>();
  let disposed = false;
  worker.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as LayoutTick & { type: string };
    if (msg && msg.type === "layout:tick") {
      for (const cb of tickListeners) cb(msg as LayoutTick);
    }
  });
  return {
    startLayout(req: LayoutRequest): void {
      if (disposed) return;
      worker.postMessage({
        type: "layout:start",
        nodes: [...req.nodes],
        links: req.links.map(([a, b]) => [a, b] as [number, number]),
        positions: req.positions,
        iterations: req.iterations,
        iterationsPerTick: req.iterationsPerTick,
        settings: req.settings,
      });
    },
    stopLayout(): void {
      if (disposed) return;
      worker.postMessage({ type: "layout:stop" });
    },
    onTick(cb: (tick: LayoutTick) => void): () => void {
      tickListeners.add(cb);
      return () => {
        tickListeners.delete(cb);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      tickListeners.clear();
      worker.terminate();
    },
  };
}

async function benchSigma(result: BenchResult): Promise<void> {
  const renderer: SigmaRenderer = createSigmaRenderer("sigma-bench", {
    layoutWorkerFactory: makeBlobWorkerClient,
  });
  const startedAt = performance.now();
  log("sigma: mounting");
  renderer.mount(container);
  renderer.set(toRendererGraph());
  result.headless = false;
  log(`sigma: set done, waiting for first frame`);

  for (
    let i = 0;
    i < 600 && result.firstFrameMs < 0 && performance.now() - startedAt < FIRST_FRAME_BUDGET_MS;
    i++
  ) {
    const sample = await sampleInRAF();
    if (sample.canvas && sample.px > 500) {
      result.firstFrameMs = Math.round(performance.now() - startedAt);
      break;
    }
    if (i === 30 || i === 100 || i === 250) log(`sigma: firstFrame wait i=${i} px=${sample.px}`);
  }
  if (result.firstFrameMs < 0) log("sigma: first-frame budget exhausted (no non-blank frame seen)");
  log(`sigma: firstFrame=${result.firstFrameMs}ms`);

  // Seed sanity (diagnostic): FA2 degenerates on pathological starts.
  const pos = renderer.getPositions();
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    bad = 0;
  pos.forEach((p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      bad++;
      return;
    }
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  log(
    `sigma: seed positions n=${pos.size} bad=${bad} x=[${minX.toFixed(1)},${maxX.toFixed(1)}] y=[${minY.toFixed(1)},${maxY.toFixed(1)}]`
  );

  // settle: the adapter's own FA2 worker run (production path).
  const settleStart = performance.now();
  log("sigma: starting FA2 layout (blob worker)");
  try {
    if (options.layoutIterations) renderer.startLayout({ iterations: options.layoutIterations });
    else renderer.startLayout();
  } catch (err) {
    log(`sigma: startLayout threw: ${String(err).slice(0, 200)}`);
    throw err;
  }
  let settled = false;
  let pollCount = 0;
  while (renderer.layoutRunning && performance.now() - settleStart < SETTLE_CAP_MS) {
    if (pollCount % 25 === 0)
      log(`sigma: layout still running at ${Math.round(performance.now() - settleStart)}ms`);
    pollCount++;
    await wait(200);
  }
  if (!renderer.layoutRunning) settled = true;
  if (renderer.layoutRunning) renderer.stopLayout();
  result.settleMs = Math.round(performance.now() - settleStart);
  result.settled = settled;
  log(`sigma: settle done ${result.settleMs}ms (cooled=${settled})`);

  renderer.resetView();
  await wait(500);
  const cam0 = renderer.getCameraState();
  if (!cam0) throw new Error("sigma camera state unavailable");
  const amplitude = cam0.ratio * 0.05;
  let theta = 0;
  const stats = await measureWindow((dtMs) => {
    theta += (2 * Math.PI * dtMs) / ORBIT_PERIOD_MS;
    renderer.setCameraState({
      x: cam0.x + amplitude * Math.cos(theta),
      y: cam0.y + amplitude * Math.sin(theta),
      ratio: cam0.ratio * (1 + 0.15 * Math.sin(theta / 2)),
    });
  });
  Object.assign(result, stats);
  renderer.dispose();
}

async function benchCosmos(result: BenchResult): Promise<void> {
  const renderer: CosmosRenderer = createCosmosRenderer("cosmos-bench");
  const startedAt = performance.now();
  renderer.mount(container);
  renderer.set(toRendererGraph());
  result.headless = renderer.headless;

  for (
    let i = 0;
    i < 600 && result.firstFrameMs < 0 && performance.now() - startedAt < FIRST_FRAME_BUDGET_MS;
    i++
  ) {
    const sample = await sampleInRAF();
    if (sample.canvas && sample.px > 500) {
      result.firstFrameMs = Math.round(performance.now() - startedAt);
      break;
    }
  }
  if (result.firstFrameMs < 0)
    log("cosmos: first-frame budget exhausted (no non-blank frame seen)");
  if (renderer.headless) throw new Error("cosmos ran headless — no GL engine");

  // No layout in this adapter (static seeded positions, CONTRACT P3);
  // "settle" is just the fit-view transition.
  const settleStart = performance.now();
  renderer.resetView();
  await wait(1500);
  result.settleMs = Math.round(performance.now() - settleStart);
  result.settled = true;

  // orbit: synthetic circular mouse drag on the canvas (d3-drag pans the
  // scene with the cursor — the real user-input path).
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("no cosmos canvas");
  const el = canvas as HTMLElement;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + WIDTH / 2;
  const cy = rect.top + HEIGHT / 2;
  const dragRadius = 110;
  const mouse = (type: string, x: number, y: number): void => {
    el.dispatchEvent(
      new MouseEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
        bubbles: true,
        cancelable: true,
        // Synthetic events have view=null by spec; d3-drag reads
        // event.view.document in nodrag() and attaches mousemove/mouseup to
        // it, so it must be the window for the drag to work at all.
        view: window as WindowProxy,
      })
    );
  };
  mouse("mousedown", cx, cy);
  let theta = 0;
  const stats = await measureWindow((dtMs) => {
    theta += (2 * Math.PI * dtMs) / ORBIT_PERIOD_MS;
    mouse("mousemove", cx + dragRadius * Math.cos(theta), cy + dragRadius * Math.sin(theta));
  });
  mouse("mouseup", cx + dragRadius * Math.cos(theta), cy + dragRadius * Math.sin(theta));
  Object.assign(result, stats);
  renderer.dispose();
}

// ---- entry --------------------------------------------------------------------

async function run(): Promise<void> {
  log(`run: renderer=${rendererId} nodes=${fixture.nodes.length} links=${fixture.links.length}`);
  // Liveness watchdog: a page whose main-thread timers stop firing shows up
  // here as a frozen beat count (headless visibility throttling / deadlocks).
  let beats = 0;
  const startedWall = performance.now();
  const watchdog = window.setInterval(() => {
    beats++;
    if (beats % 5 === 0)
      log(`watchdog: beats=${beats} (${Math.round(performance.now() - startedWall)}ms)`);
  }, 1000);
  // Install the real palette through the real config path (stubbed fetch —
  // same as the D3 render check; no test backdoor in src/config).
  const palette = [
    { group: "DataCatalog", type: "DataCatalog", color: "#4B0082" },
    { group: "Dataset", type: "Dataset", color: "#0000FF" },
    { group: "Document", type: "Document", color: "#FFA500" },
    { group: "Event", type: "Event", color: "#00FFFF" },
    { group: "Institution", type: "Institution", color: "#008000" },
    { group: "Instrument", type: "Instrument", color: "#A52A2A" },
    { group: "Software", type: "Software", color: "#FFFF00" },
    { group: "Person", type: "Person", color: "#FF0000" },
  ];
  const realFetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/config")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            relation_properties: [],
            label_properties: ["label"],
            skip_types: [],
            types: palette,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }
    return realFetch(input, init);
  };
  await loadConfig();
  window.fetch = realFetch;

  const result: BenchResult = {
    renderer: rendererId,
    nodes: fixture.nodes.length,
    links: fixture.links.length,
    headless: true,
    firstFrameMs: -1,
    settleMs: 0,
    settled: false,
    windowMs: 0,
    frameCount: 0,
    fpsMean: 0,
    fpsMedian: 0,
    fpsMin: 0,
    frameMsP50: 0,
    frameMsP90: 0,
    motionPx: 0,
  };

  try {
    if (rendererId === "fgraph3d") {
      await benchFgraph3d(result);
    } else if (rendererId === "sigma") {
      await benchSigma(result);
    } else {
      await benchCosmos(result);
    }
  } catch (err) {
    result.error = String(err instanceof Error ? (err.stack ?? err) : err);
  } finally {
    window.clearInterval(watchdog);
    (window as unknown as { __BENCH_RESULT__: BenchResult }).__BENCH_RESULT__ = result;
    document.title = result.error ? "BENCH_ERR" : `BENCH_OK:${rendererId}:${result.nodes}`;
  }
}

void run();

// Report fatal page errors so the driver can surface them even on a timeout.
window.addEventListener("error", (event) => {
  if (/ResizeObserver loop/.test(event.message)) return;
  (window as unknown as { __BENCH_ERROR__?: string }).__BENCH_ERROR__ = String(
    event.error?.stack ?? event.message
  )
    .split("\n")
    .slice(0, 6)
    .join(" | ");
});
