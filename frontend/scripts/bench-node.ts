// Card D5 S2 — Node-side performance benchmark (no browser).
//
// Owner directive (2026-11-03): browser checks are DISABLED for this card —
// no Playwright/Chromium/walkthroughs. The GPU draw cost is therefore NOT
// measurable here; this harness measures the CPU side the committed
// production code actually runs under Node:
//
//   sigma    — real sigma v3 adapter (fake DOM, D2's fake-dom.ts) + real
//              force-atlas2 layout worker (forceatlas2.worker.ts bundled
//              for node:worker_threads — the same worker file and message
//              protocol the browser Worker uses). Measures: fixture
//              parse/map, adapter set(), first render pass, FA2 tick
//              arrival rate (worker→main round trip, including the
//              adapter's real per-tick apply), settle wall time, a
//              standalone apply pass replicating applyLayoutTick on an
//              equivalent graphology graph, and one post-layout render
//              pass (JS scene cost on the no-op GL stub).
//   cosmos   — real cosmos.gl adapter in its headless (state-only) mode:
//              parse/map + set() (deterministic seed of ALL positions,
//              CONTRACT P3). No layout exists in this adapter (static
//              seeded positions); GL draw needs a GPU context.
//   fgraph3d — the app's current 3D view layout, verbatim: d3-force-3d
//              simulation with three-forcegraph's EXACT defaults
//              (forceLink + forceManyBody + forceCenter, no custom
//              strengths; warmupTicks 0) and Graph.tsx's d3AlphaDecay
//              0.02 / d3VelocityDecay 0.3. Manual .tick() loop — the
//              library ticks once per animation frame in the browser —
//              until alpha < alphaMin (d3 default 0.001).
//
// Protocol: every (renderer × size) run is CPU-gated first (this VM
// suffers intermittent host-vCPU starvation — a benchmark measured inside
// one is garbage), repeated --reps times; the report uses medians. Raw
// per-rep rows land in the results JSON.
//
// Usage (from frontend/, via the driver):
//   node scripts/bench-node.mjs [--sizes 5k,25k] [--reps 3] [--out FILE]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform, release, type } from "node:os";
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fake-dom auto-installs on import and MUST come before ../src/render
// (sigma's bundle reads WebGL2RenderingContext at module level).
import { FakeElement, flushRaf, glCounts } from "./fake-dom";
import type { LayoutRequest, LayoutTick, LayoutWorkerClient } from "../src/render/layout-worker";
import type { RendererGraph } from "../src/render/renderer";
import { createSigmaRenderer, type SigmaRenderer } from "../src/render/sigma";
import { createCosmosRenderer, type CosmosRenderer } from "../src/render/cosmos";
import { Graph } from "graphology";
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

// ---- args --------------------------------------------------------------------

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return process.argv[i + 1] ?? dflt;
}

const FRONTEND = process.env.BENCH_FRONTEND ?? dirname(dirname(fileURLToPath(import.meta.url)));
const SIZES = arg("sizes", "5k,25k")
  .split(",")
  .map((s) => s.trim());
const REPS = Number(arg("reps", "3"));
const OUT = arg("out", join(FRONTEND, "docs", "benchmark-data", "d5-node-results.json"));
const FIXTURES_DIR = join(FRONTEND, "scripts", "fixtures");
const WORKER_PATH = process.env.FORCEATLAS2_WORKER_PATH;
if (!WORKER_PATH) {
  console.error("bench-node: FORCEATLAS2_WORKER_PATH must be set by scripts/bench-node.mjs");
  process.exit(2);
}
/** Safety cap for one layout run (s). A healthy 25k run is seconds. */
const LAYOUT_CAP_MS = 20 * 60 * 1000;

// ---- helpers -------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

const log = (s: string): void => {
  console.log(`[bench-node] ${s}`);
};

/** Run the GC if the driver enabled --expose-gc (cleaner heap deltas). */
function gc(): void {
  const g = globalThis as { gc?: () => void };
  g.gc?.();
}

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1048576;
}

// ---- CPU health gate (same probe as scripts/bench-fps.mjs) ----------------------
// Host-level vCPU starvation on this VM: a full-core busy loop can earn a
// fraction of one core while every guest thread is parked. /proc/stat first
// line: cpu <user> <nice> ... — user is field 1.
function userJiffies(): number {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/);
  return Number(line[1]) + Number(line[2]);
}

/** Spin ~1.5 s and measure how much of a core we actually got. */
function probeCpu(): number {
  const before = userJiffies();
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    /* burn one core */
  }
  const wall = Date.now() - t0;
  const after = userJiffies();
  return (after - before) / 100 / (wall / 1000);
}

async function waitHealthyCpu(minRatio = 0.8, tries = 24): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const ratio = probeCpu();
    log(`CPU probe: ${Math.round(ratio * 100)}% of one core${i > 0 ? ` (attempt ${i + 1})` : ""}`);
    if (ratio >= minRatio) return true;
    log("CPU starved (host vCPUs withheld) — retrying in 25s");
    await new Promise((resolve) => setTimeout(resolve, 25000));
  }
  return false;
}

// ---- fixture --------------------------------------------------------------------

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
interface FixtureDoc {
  nodes: FixtureNode[];
  links: FixtureLink[];
}

/** Time JSON.parse + the mapping to the GraphRenderer contract shape. */
function ingest(raw: string): { parseMs: number; mapMs: number; graph: RendererGraph } {
  let t0 = performance.now();
  const doc: FixtureDoc = JSON.parse(raw);
  const parseMs = performance.now() - t0;

  t0 = performance.now();
  const graph: RendererGraph = {
    nodes: doc.nodes.map((n) => ({ id: n.id, label: n.label, group: n.group })),
    links: doc.links.map((l, i) => ({
      id: `l-${i}`,
      source: l.source,
      target: l.target,
      label: l.label,
    })),
  };
  const mapMs = performance.now() - t0;
  return { parseMs, mapMs, graph };
}

// ---- node worker client (same as scripts/render-layout.test.ts) ------------------

function createNodeLayoutWorker(
  observer: (tick: LayoutTick, at: number) => void
): LayoutWorkerClient {
  const worker = new Worker(WORKER_PATH, { type: "module" });
  const tickListeners = new Set<(tick: LayoutTick) => void>();
  let disposed = false;
  // EventEmitter API (worker_threads Worker has no EventTarget API on this
  // Node) — same as scripts/render-layout.test.ts.
  worker.on("message", (data: unknown) => {
    const msg = data as LayoutTick & { type: string };
    if (msg && msg.type === "layout:tick") {
      observer(msg, performance.now());
      for (const cb of tickListeners) cb(msg);
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
        iterations: req.iterations ?? 300,
        iterationsPerTick: req.iterationsPerTick ?? 16,
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

// ---- sigma ------------------------------------------------------------------------

interface RowBase {
  renderer: string;
  size: string;
  rep: number;
  nodes: number;
  links: number;
  cpuProbePct: number;
  parseMs: number;
  mapMs: number;
  [key: string]: number | string | boolean;
}

async function benchSigma(size: string, rep: number, raw: string): Promise<RowBase> {
  const { parseMs, mapMs, graph } = ingest(raw);
  const row: RowBase = {
    renderer: "sigma",
    size,
    rep,
    nodes: graph.nodes.length,
    links: graph.links.length,
    cpuProbePct: 0,
    parseMs: round2(parseMs),
    mapMs: round2(mapMs),
  };

  const container = new FakeElement("DIV") as unknown as HTMLElement;
  const arrivals: number[] = [];
  let firstTickMs = -1;
  let doneAt = -1;
  let tickCount = 0;
  let iterations = 0;
  let lastPositions: Float32Array | null = null;
  const observer = (tick: LayoutTick, at: number): void => {
    if (arrivals.length === 0) firstTickMs = at;
    arrivals.push(at);
    tickCount++;
    iterations = tick.iteration;
    lastPositions = tick.positions;
    if (tick.done) doneAt = at;
  };
  const renderer: SigmaRenderer = createSigmaRenderer(`bench-sigma-${size}-rep${rep}`, {
    layoutWorkerFactory: () => createNodeLayoutWorker(observer),
  });
  renderer.mount(container);

  // One pumped frame BATCH (flushRaf default = up to 8 passes): sigma's
  // first frame after set() may need more than one rAF pass (resize, then
  // render). glCounts proves the batch really drew (fake-dom records every
  // no-op GL call).
  const glBase = { drawCalls: glCounts.drawCalls, bufferData: glCounts.bufferData };
  gc();
  const heapBeforeSet = heapMB();
  const t0 = performance.now();
  renderer.set(graph);
  const setMs = performance.now() - t0;
  const r0 = performance.now();
  flushRaf();
  const firstRenderPassMs = performance.now() - r0;
  const firstPassDrawCalls = glCounts.drawCalls - glBase.drawCalls;
  const firstPassBuffers = glCounts.bufferData - glBase.bufferData;
  if (firstPassDrawCalls <= 0) log(`WARN sigma ${size}: first frame batch drew 0 calls`);
  gc();
  row.setMs = round2(setMs);
  row.firstRenderPassMs = round2(firstRenderPassMs);
  row.firstPassDrawCalls = firstPassDrawCalls;
  row.firstPassBuffers = firstPassBuffers;
  row.heapSetDeltaMB = round2(heapMB() - heapBeforeSet);

  // Layout run: production defaults (300 iterations, 16 per tick).
  const startAt = performance.now();
  renderer.startLayout();
  while (doneAt < 0 && performance.now() - startAt < LAYOUT_CAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  renderer.stopLayout();
  const settleMs = doneAt >= 0 ? doneAt - startAt : -1;
  row.settleMs = Math.round(settleMs);
  row.tickCount = tickCount;
  row.iterations = iterations;

  if (arrivals.length > 1) {
    const intervals: number[] = [];
    for (let i = 1; i < arrivals.length; i++) intervals.push(arrivals[i] - arrivals[i - 1]);
    intervals.sort((a, b) => a - b);
    const p50 = percentile(intervals, 0.5);
    row.firstTickMs = round2(firstTickMs - startAt);
    row.tickP50Ms = round2(p50);
    row.tickP90Ms = round2(percentile(intervals, 0.9));
    row.tickRatePerSec = p50 > 0 ? round2(1000 / p50) : 0;
  } else {
    row.firstTickMs = -1;
    row.tickP50Ms = 0;
    row.tickP90Ms = 0;
    row.tickRatePerSec = 0;
  }

  // Standalone apply pass: the exact call applyLayoutTick makes, per node,
  // on a graphology graph with the same node/edge counts and attribute
  // shape (the adapter's own graph is private; mergeNodeAttributes is the
  // real graphology API either way).
  if (lastPositions) {
    const equivalent = new Graph();
    const ids = graph.nodes.map((n) => n.id);
    for (const id of ids) equivalent.addNode(id, { x: 0, y: 0, label: "", group: "" });
    for (const l of graph.links) equivalent.addEdge(l.source, l.target, { label: "", color: "" });
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = performance.now();
      for (let k = 0; k < ids.length; k++) {
        equivalent.mergeNodeAttributes(ids[k], {
          x: lastPositions[2 * k],
          y: lastPositions[2 * k + 1],
        });
      }
      samples.push(performance.now() - a);
    }
    row.applyPassP50Ms = round2(percentile(samples, 0.5));
  }

  // One more frame batch after layout: steady-state JS scene pass (buffers
  // exist, every node's attributes were just updated by the final tick —
  // that refresh is the frame still queued when the run ends).
  glCounts.drawCalls = 0;
  glCounts.bufferData = 0;
  const s0 = performance.now();
  flushRaf();
  row.steadyRenderPassMs = round2(performance.now() - s0);
  row.steadyPassDrawCalls = glCounts.drawCalls;
  gc();
  row.heapEndDeltaMB = round2(heapMB() - heapBeforeSet);

  renderer.dispose();
  return row;
}

// ---- cosmos -----------------------------------------------------------------------

function benchCosmos(size: string, rep: number, raw: string): RowBase {
  const { parseMs, mapMs, graph } = ingest(raw);
  const row: RowBase = {
    renderer: "cosmos",
    size,
    rep,
    nodes: graph.nodes.length,
    links: graph.links.length,
    cpuProbePct: 0,
    parseMs: round2(parseMs),
    mapMs: round2(mapMs),
    layout: "none (static seeded positions, CONTRACT P3)",
  };
  const renderer: CosmosRenderer = createCosmosRenderer(`bench-cosmos-${size}-rep${rep}`);
  renderer.mount(null as unknown as HTMLElement); // headless mode: null container
  gc();
  const heapBeforeSet = heapMB();
  const t0 = performance.now();
  renderer.set(graph);
  row.setMs = round2(performance.now() - t0);
  gc();
  row.heapSetDeltaMB = round2(heapMB() - heapBeforeSet);
  row.headless = renderer.headless;
  renderer.dispose();
  return row;
}

// ---- fgraph3d -----------------------------------------------------------------------
// d3-force-3d types are not in @types here; the library is a plain ESM d3
// module and esbuild strips this file's types without checking them.
type D3Sim = {
  force: (name: string, force: unknown) => D3Sim;
  numDimensions: (n: number) => D3Sim;
  alphaDecay: (v: number) => D3Sim;
  velocityDecay: (v: number) => D3Sim;
  alpha: () => number;
  alphaMin: () => number;
  stop: () => D3Sim;
  tick: () => void;
};

async function benchFgraph3d(size: string, rep: number, raw: string): Promise<RowBase> {
  const { parseMs, mapMs, graph } = ingest(raw);
  const row: RowBase = {
    renderer: "fgraph3d",
    size,
    rep,
    nodes: graph.nodes.length,
    links: graph.links.length,
    cpuProbePct: 0,
    parseMs: round2(parseMs),
    mapMs: round2(mapMs),
  };

  const nodes = graph.nodes.map((n) => ({ id: n.id, label: n.label, group: n.group }));
  const links = graph.links.map((l) => ({ source: l.source, target: l.target }));

  gc();
  const heapBefore = heapMB();
  const i0 = performance.now();
  // three-forcegraph's exact default construction (verified against the
  // installed dist): link + charge + center, no custom strengths, warmup 0;
  // data fed via .nodes() + linkForce.id(d => d.id) + .numDimensions(3).
  const sim = forceSimulation(nodes) as unknown as D3Sim;
  sim.numDimensions(3);
  sim.force(
    "link",
    (forceLink(links) as { id: (fn: (d: { id: string }) => string) => unknown }).id((d) => d.id)
  );
  sim.force("charge", forceManyBody());
  sim.force("center", forceCenter());
  // Graph.tsx: d3AlphaDecay 0.02, d3VelocityDecay 0.3.
  sim.alphaDecay(0.02);
  sim.velocityDecay(0.3);
  sim.stop(); // no internal timer — we drive .tick() manually, like the
  // browser's one-tick-per-animation-frame engine loop.
  row.simInitMs = round2(performance.now() - i0);

  const ticks: number[] = [];
  const t0 = performance.now();
  while (sim.alpha() >= sim.alphaMin()) {
    const a = performance.now();
    sim.tick();
    ticks.push(performance.now() - a);
    if ((ticks.length & 0x3f) === 0 && performance.now() - t0 > LAYOUT_CAP_MS) {
      row.error = "layout cap exceeded";
      break;
    }
  }
  const settleMs = performance.now() - t0;
  row.settleMs = Math.round(settleMs);
  row.tickCount = ticks.length;
  if (ticks.length > 0) {
    ticks.sort((a, b) => a - b);
    const p50 = percentile(ticks, 0.5);
    row.tickP50Ms = round2(p50);
    row.tickP90Ms = round2(percentile(ticks, 0.9));
    row.tickRatePerSec = p50 > 0 ? round2(1000 / p50) : 0;
  } else {
    row.tickP50Ms = 0;
    row.tickP90Ms = 0;
    row.tickRatePerSec = 0;
  }
  gc();
  row.heapEndDeltaMB = round2(heapMB() - heapBefore);
  return row;
}

// ---- driver -------------------------------------------------------------------------

async function main(): Promise<void> {
  const libVersion = (name: string): string => {
    try {
      return JSON.parse(readFileSync(join(FRONTEND, "node_modules", name, "package.json"), "utf8"))
        .version;
    } catch {
      return "unknown";
    }
  };
  const env = {
    harness: "bench-node (card D5 S2)",
    date_utc: new Date().toISOString(),
    host: hostname(),
    os: `${platform()} ${release()} (${type()})`,
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    libs: {
      sigma: libVersion("sigma"),
      "react-force-graph-3d": libVersion("react-force-graph-3d"),
      "three-forcegraph": libVersion("three-forcegraph"),
      "d3-force-3d": libVersion("d3-force-3d"),
      "cosmos.gl/graph": libVersion("@cosmos.gl/graph"),
      graphology: libVersion("graphology"),
      three: libVersion("three"),
    },
    args: { sizes: SIZES, reps: REPS },
  };
  log(JSON.stringify(env));

  const rows: RowBase[] = [];
  let failed = 0;
  for (const size of SIZES) {
    const fixtureFile = join(FIXTURES_DIR, `qllever-dev-${size}.json`);
    const raw = readFileSync(fixtureFile, "utf8");
    for (const renderer of ["sigma", "fgraph3d", "cosmos"] as const) {
      for (let rep = 1; rep <= REPS; rep++) {
        if (!(await waitHealthyCpu())) {
          failed++;
          rows.push({
            renderer,
            size,
            rep,
            nodes: 0,
            links: 0,
            cpuProbePct: 0,
            parseMs: 0,
            mapMs: 0,
            error: "skipped: CPU starved (host vCPUs withheld)",
          });
          log(`SKIP ${renderer} ${size} rep${rep}: CPU starved`);
          continue;
        }
        const probe = probeCpu();
        const runStart = Date.now();
        try {
          let row: RowBase;
          if (renderer === "sigma") row = await benchSigma(size, rep, raw);
          else if (renderer === "fgraph3d") row = await benchFgraph3d(size, rep, raw);
          else row = benchCosmos(size, rep, raw);
          row.cpuProbePct = Math.round(probe * 100);
          rows.push(row);
          const layout =
            "tickP50Ms" in row
              ? ` tickP50=${row.tickP50Ms}ms rate=${row.tickRatePerSec}/s settle=${row.settleMs}ms`
              : "";
          log(
            `BENCH ${renderer} ${size} rep${rep}: set=${row.setMs ?? "-"}ms` +
              `${layout} (${Math.round((Date.now() - runStart) / 1000)}s)`
          );
        } catch (err) {
          failed++;
          rows.push({
            renderer,
            size,
            rep,
            nodes: 0,
            links: 0,
            cpuProbePct: 0,
            parseMs: 0,
            mapMs: 0,
            error: String(err instanceof Error ? (err.stack ?? err) : err).slice(0, 400),
          });
          log(`FAILED ${renderer} ${size} rep${rep}: ${String(err).slice(0, 200)}`);
        }
      }
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ env, rows }, null, 2));
  log(`wrote ${OUT}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
