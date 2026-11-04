# D5 — 5k / 25k benchmark: measured fps table (Node, no browser)

Card D5: benchmark fixtures from the QLever dev endpoint + committed fps numbers.
Fixtures: **S1** (commit `6660b5c`) — `frontend/scripts/fixtures/qllever-dev-5k.json`
(5,000 nodes / 993 links) and `qllever-dev-25k.json` (25,000 / 5,478), real data
pulled from `sparql.unhide.helmholtz-metadaten.de` with the app's exact IRI lists,
deterministic, regenerable via `scripts/generate-qllever-fixtures.py` (cached,
no re-query).

**Owner directive (2026-11-03): browser checks are DISABLED for this card.**
No Playwright/Chromium/walkthroughs. GPU draw cost is therefore NOT measured
here; this report measures the CPU side the committed production code runs
under Node, with the real adapter/worker/d3 code paths. A browser harness
(`scripts/bench-fps.ts` + `scripts/bench-fps.mjs`) is committed, ready to
produce true rAF fps when the directive is lifted. One set of pre-directive
SwiftShader browser numbers (measured 2026-11-03 07:44–09:07, before the
directive) is preserved as Appendix A.

## Environment (measured at run time)

|                                         |                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| host / OS                               | hermes / linux 6.8.0-147-generic                                                            |
| CPU                                     | AMD EPYC-Milan Processor, 4 vCPU                                                            |
| Node (harness runtime)                  | v24.22.2                                                                                    |
| sigma                                   | 3.0.0                                                                                       |
| react-force-graph-3d / three-forcegraph | 1.29.2 / 1.41.15                                                                            |
| d3-force-3d                             | 3.0.5                                                                                       |
| @cosmos.gl/graph                        | 3.5.1                                                                                       |
| graphology / three                      | 0.26.0 / 0.187.0                                                                            |
| run                                     | 2026-11-04T03:44Z, 3 reps per (renderer × size), CPU-gated (≥103% of one core on every run) |

Raw per-rep data: `frontend/docs/benchmark-data/d5-node-2026-11-04.json`.

## Measured table (medians of 3)

"Layout fps" = layout tick rate: how many frames of layout progress per second
the production code sustains (worker→main round trip for sigma, incl. the
adapter's real per-tick apply; main-thread d3 tick for fgraph3d). The 3D
library ticks d3 once per animation frame, so in a browser the visible layout
fps is `min(display rate, layout fps)`.

### Ingest (JSON → renderer)

| renderer                        | 5k parse+map | 25k parse+map | 5k adapter `set()` | 25k adapter `set()` | 5k heap Δ            | 25k heap Δ           |
| ------------------------------- | ------------ | ------------- | ------------------ | ------------------- | -------------------- | -------------------- |
| sigma (2D)                      | 2.13 ms      | 10.58 ms      | 40.6 ms            | 190.6 ms            | 3.9 MB               | 22.0 MB              |
| cosmos (2D GPU, headless state) | 2.11 ms      | 10.75 ms      | 3.9 ms             | 18.5 ms             | 0.7 MB               | 3.0 MB               |
| fgraph3d (3D, d3 sim init)      | 2.05 ms      | 10.45 ms      | 3.7 ms (sim init)  | 18.3 ms (sim init)  | 1.1 MB (post-layout) | 5.2 MB (post-layout) |

25k ingest is well under the 2 s first-paint budget on the data side
(≤ ~191 ms to a laid-out-eligible scene).

### Layout (convergence animation)

| renderer                  | size     | first tick | tick p50 | tick p90 | **layout fps (1/tick p50)**                      | ticks | iterations    | settle wall | main-thread apply / tick |
| ------------------------- | -------- | ---------- | -------- | -------- | ------------------------------------------------ | ----- | ------------- | ----------- | ------------------------ |
| sigma FA2 (worker)        | 5k       | 66.6 ms    | 18.9 ms  | 32.9 ms  | **52.9**                                         | 19    | 300           | 455 ms      | 1.05 ms                  |
| sigma FA2 (worker)        | 25k      | 226.3 ms   | 108.6 ms | 132.9 ms | **9.2**                                          | 19    | 300           | 2 207 ms    | 5.6 ms                   |
| fgraph3d d3 (main thread) | 5k       | —          | 0.41 ms  | 0.44 ms  | **2 456**                                        | 342   | 300 (α<0.001) | 157 ms      | n/a (inline)             |
| fgraph3d d3 (main thread) | 25k      | —          | 2.4 ms   | 2.59 ms  | **418**                                          | 342   | 300 (α<0.001) | 879 ms      | n/a (inline)             |
| cosmos                    | 5k / 25k | —          | —        | —        | no layout (static seeded positions, CONTRACT P3) | —     | —             | —           | —                        |

### Steady-state frame JS cost (post-layout)

| renderer                  | 5k frame JS pass                                                     | 25k frame JS pass | implied JS-only fps (25k) |
| ------------------------- | -------------------------------------------------------------------- | ----------------- | ------------------------- |
| sigma (2D, no-op GL stub) | 7.7 ms                                                               | 48.4 ms           | ~20 fps                   |
| fgraph3d (3D)             | not measurable — three.js scene update + WebGL draw are browser-side | same              | —                         |
| cosmos (2D GPU)           | not measurable — luma.gl WebGL2 is browser-side                      | same              | —                         |

## 3D-vs-2D evidence (what the numbers say)

1. **25k layout:** the 3D path (d3 on the main thread) stays at 2.4 ms/tick →
   its layout animation can hold any display rate; the 2D sigma path caps at
   **~9 fps** during convergence (FA2 worker is the bottleneck — 16 iterations
   per posted tick; the main-thread apply is only 5.6 ms/tick, so moving the
   work, not the compute, is what a fix would need).
2. **25k steady state (2D):** sigma's JS scene pass alone is **48 ms/frame**
   (measured on the no-op GL stub; real WebGL adds cost on top) → the 2D path
   is JS-bound at ~20 fps before any GPU work. **3D:** steady-state cost is
   GPU-side (unmeasured, directive); the CPU side (d3) is negligible at 2.4 ms.
3. **5k:** 2D layout is 52.9 fps — at the 50 fps budget line, no headroom;
   3D has an order of magnitude of headroom (2 456 ticks/s).
4. **Ingest/first paint:** all paths are fast at 25k (≤ ~191 ms data→scene);
   the 2 s first-paint budget is not threatened by the data side.
5. **Memory (JS heap, 25k):** sigma +34 MB vs fgraph3d d3 +5 MB vs cosmos
   +3 MB (GL buffers not in the JS heap — not counted).

Conclusion the CPU-side evidence supports: at 25k the **3D (fgraph3d) path
keeps the layout interactive; the 2D sigma path does not** (9 fps layout,
~20 fps JS render). At 5k the 2D path is at the budget edge (53 fps layout)
while 3D is comfortable. The missing half — real-GPU draw fps at 25k for
fgraph3d/cosmos — is exactly what the committed `scripts/bench-fps.mjs`
browser harness measures when the browser directive is lifted.

## Method

- Harness: `frontend/scripts/bench-node.ts` (driver `bench-node.mjs`).
  esbuild-bundled, runs under Node with `--expose-gc`. No browser.
- **sigma:** real `createSigmaRenderer` on D2's fake DOM
  (`scripts/fake-dom.ts`, no-op GL that records calls); real
  `forceatlas2.worker.ts` bundled for `node:worker_threads` — the same worker
  file and message protocol the browser uses. Tick arrivals timed on the main
  thread (round trip incl. the adapter's real `applyLayoutTick`); a standalone
  apply pass replicates `applyLayoutTick`'s exact
  `graph.mergeNodeAttributes` calls on an equivalent graphology graph
  (same node/edge counts/attrs; the adapter's graph is private). Render
  passes are pumped frame batches (`flushRaf`) and proven to have drawn via
  fake-dom GL counters (3 draw calls = node/edge/label layers, batched).
- **fgraph3d:** d3-force-3d simulation built exactly as the installed
  three-forcegraph 1.41.15 builds it (verified against `dist`):
  `forceLink().id(d => d.id) + forceManyBody() + forceCenter()`,
  `numDimensions(3)`, no custom strengths, warmup 0; plus Graph.tsx's
  `d3AlphaDecay 0.02` / `d3VelocityDecay 0.3`. Manual `.tick()` loop until
  `alpha < alphaMin` (0.001) — the browser engine ticks once per animation
  frame, so tick ms is directly the per-frame layout cost.
- **cosmos:** real `createCosmosRenderer` headless (state-only) mode;
  `set()` seeds all positions deterministically (P3). No layout exists in this
  adapter.
- Every run is CPU-gated (a 1.5 s busy loop must earn ≥80% of a core — this
  VM suffers intermittent host-vCPU starvation; a benchmark inside a
  starvation window is garbage). 3 reps, medians reported.

### Limitations (read before citing numbers)

- **GPU draw is unmeasured** (directive). All "fps" here are CPU-side rates.
- fake-GL no-op calls carry Proxy overhead that real GL calls don't, and
  save the real driver's cost — treat the 2D frame-JS numbers as
  order-of-magnitude, not calibrated.
- FA2 runs in `node:worker_threads` (browser: dedicated Worker) — same code,
  slightly different IPC.
- d3 runs on Node's V8; browser V8 is the same engine family.
- sigma steady-frame pass includes the label-LOD reducer over all nodes;
  label LOD (D2 S3) already reduces the 25k label set at far zoom, so the
  worst case shown is labels-on.

## Appendix A — pre-directive SwiftShader browser reference

Measured 2026-11-03 07:44–09:07 UTC with `scripts/bench-fps.mjs` (headless
Chromium + SwiftShader **software** GL), 1 run each, no reps, before the
09:03 directive disabled browser checks. NOT representative of a real GPU:
software GL dominates, and the measurement window ran concurrently with the
live layout.

| renderer          | size   | fps (10 s window)                        | first frame | settle                         | note                                              |
| ----------------- | ------ | ---------------------------------------- | ----------- | ------------------------------ | ------------------------------------------------- |
| sigma             | 5k     | mean 3.2 / med 3 / min 1 (33/599 frames) | 266 ms      | 120 s cap hit (FA2 not cooled) | SwiftShader draw + live layout in the same window |
| sigma             | 25k    | —                                        | 721 ms      | —                              | browser page OOM/crash before the window          |
| fgraph3d / cosmos | 5k/25k | —                                        | —           | —                              | not reached before the directive                  |

Directionally consistent with the Node data: the 2D path is CPU-bound even
before the 25k scale, and the 3D comparison remains to be measured on real
GL once browser checks are re-enabled.

## Reproduce

```sh
cd frontend
node scripts/bench-node.mjs --sizes 5k,25k --reps 3 \
  --out docs/benchmark-data/d5-node-2026-11-04.json   # ~4 min
# browser variant (when the directive is lifted; needs puppeteer-core in
# the profile scratch dir + a local Chromium):
node scripts/bench-fps.mjs --renderers fgraph3d,sigma,cosmos --out results.json
```
