// Card D5 — driver for the fps benchmark (scripts/bench-fps.ts).
//
// 1. Bundles the in-page harness (esbuild IIFE, same resolution trick the
//    D3 render check uses) AND the FA2 worker source (IIFE — injected as a
//    blob for the sigma adapter's layout-worker seam).
// 2. For each (renderer × fixture size): loads the committed QLever-dev
//    fixture into a FRESH headless Chromium page (SwiftShader software GL),
//    waits for window.__BENCH_RESULT__, writes a screenshot.
// 3. Prints the measured table; with --out, writes the raw results JSON.
//
// Usage (from the repo root or frontend/):
//   node scripts/bench-fps.mjs [--renderers fgraph3d,sigma,cosmos]
//                              [--sizes 5k,25k]
//                              [--measure 10000] [--settle-cap 120000]
//                              [--orbit 4000] [--timeout 300000]
//                              [--out results.json] [--screenshots DIR]
//
// Needs `puppeteer-core` (NOT a project dependency — a verification tool;
// a scratch symlink into profile scratch, gitignored) and a headless
// Chromium. Browser discovery order: $PUPPETEER_EXECUTABLE_PATH →
// well-known local shells → puppeteer default.
//
// Exit: 0 when every run produced a result, 1 when any run failed, 2 when
// the verification tooling is unavailable.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, hostname, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(frontend, "scripts", "bench-fps.ts");
const workerEntry = join(frontend, "src", "render", "forceatlas2.worker.ts");
const fixturesDir = join(frontend, "scripts", "fixtures");

// ---- args --------------------------------------------------------------------
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return process.argv[i + 1] ?? dflt;
}

const RENDERERS = arg("renderers", "fgraph3d,sigma,cosmos")
  .split(",")
  .map((s) => s.trim());
const SIZES = arg("sizes", "5k,25k")
  .split(",")
  .map((s) => s.trim());
const MEASURE_MS = Number(arg("measure", "10000"));
const SETTLE_CAP_MS = Number(arg("settle-cap", "120000"));
const ORBIT_MS = Number(arg("orbit", "4000"));
const TIMEOUT_MS = Number(arg("timeout", "1800000"));
const LAYOUT_ITER = process.argv.includes("--layout-iterations")
  ? Number(process.argv[process.argv.indexOf("--layout-iterations") + 1])
  : 0;
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const SHOT_DIR = arg("screenshots", mkdtempSync(join(tmpdir(), "bench-fps-")));
if (process.argv.includes("--screenshots")) mkdirSync(SHOT_DIR, { recursive: true });

// ---- 0. CPU health gate -------------------------------------------------------
// This VM suffers intermittent HOST-LEVEL vCPU starvation (observed: a
// full-core busy loop earning 9% of one core for 20s, all guest threads
// parked, no cgroup quota involved — the hypervisor withholds vCPUs). A
// benchmark measured inside a starvation window is garbage and looks like
// a hang, so every run is gated on a short probe of the driver's own core.
function userJiffies() {
  // /proc/stat first line: cpu <user> <nice> <system> <idle> ... — line[0]
  // is "cpu", so user is line[1] (the earlier line[2] read the *nice* field,
  // which is flat for non-niced processes and made every probe read 0%).
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/);
  return Number(line[1]) + Number(line[2]);
}

/** Spin ~1.5s and measure how much of a core we actually got. */
function probeCpu() {
  const before = userJiffies();
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    /* burn one core */
  }
  const wall = Date.now() - t0;
  const after = userJiffies();
  return (after - before) / 100 / (wall / 1000);
}

async function waitHealthyCpu(minRatio = 0.8, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const ratio = probeCpu();
    console.log(
      `CPU probe: ${Math.round(ratio * 100)}% of one core${i > 0 ? ` (attempt ${i + 1})` : ""}`
    );
    if (ratio >= minRatio) return true;
    console.log("CPU starved (host vCPUs withheld) — retrying in 25s");
    await new Promise((resolve) => setTimeout(resolve, 25000));
  }
  return false;
}

// ---- 1. bundle ----------------------------------------------------------------
const requireFromFrontend = createRequire(join(frontend, "package.json"));
const esbuild = createRequire(requireFromFrontend.resolve("vite"))("esbuild");
const outDir = mkdtempSync(join(tmpdir(), "bench-fps-build-"));
const bundle = join(outDir, "bench-fps.iife.js");
const workerBundle = join(outDir, "fa2-worker.iife.js");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  logLevel: "warning",
  nodePaths: [join(frontend, "node_modules")],
  outfile: bundle,
});
await esbuild.build({
  entryPoints: [workerEntry],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  logLevel: "warning",
  nodePaths: [join(frontend, "node_modules")],
  // The Node branch (worker_threads) is runtime-gated to isNodeRuntime and
  // never executes in a browser Worker — leave the lazy import as-is.
  external: ["node:worker_threads"],
  outfile: workerBundle,
});
const harnessSrc = readFileSync(bundle, "utf8");
const workerSrc = readFileSync(workerBundle, "utf8");

// ---- 2. locate a headless browser ---------------------------------------------
function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p;
  return undefined;
}
const browserExecutable =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  firstExisting([
    join(
      homedir(),
      ".cache",
      "ms-playwright",
      "chromium_headless_shell-1181",
      "chrome-linux",
      "headless_shell"
    ),
    join(homedir(), ".cache", "puppeteer", "chrome-headless-shell"),
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ]);

// ---- 3. drive ------------------------------------------------------------------
let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.error("bench-fps: 'puppeteer-core' is not installed.");
  console.error(
    "This is a VERIFICATION tool, not an app dependency. Reinstall it in the profile scratch dir and re-symlink frontend/node_modules/puppeteer-core."
  );
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: browserExecutable, // undefined → puppeteer's default
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu",
    "--hide-scrollbars",
    // A headless page whose only output is a 2D canvas gets classified as
    // occluded and the renderer's main thread is PAUSED (observed: every
    // thread parked in futex_wait, timers/rAF/worker messages stop, CPU
    // 0%). The WebGL renderers keep the page "active" so they dodge it —
    // the 2D runs need occlusion-based throttling disabled to measure.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion",
  ],
});

// A disconnect at close time is normal teardown; a mid-run one (crash/OOM)
// must abort the remaining runs WITHOUT losing already-collected results, so
// this only sets a flag — the results file is written after browser.close().
let browserLost = false;
browser.on("disconnected", () => {
  browserLost = true;
  console.error("BENCH DRIVER: browser disconnected (crash/OOM?) — aborting remaining runs");
});

const results = [];
let failed = 0;
try {
  for (const renderer of RENDERERS) {
    for (const size of SIZES) {
      if (browserLost) {
        const result = {
          renderer,
          nodes: null,
          links: null,
          error: "aborted: browser lost",
        };
        failed++;
        results.push(result);
        console.log(`BENCH ${renderer} ${size}: ABORTED (browser lost)`);
        continue;
      }
      if (!(await waitHealthyCpu())) {
        const result = {
          renderer,
          nodes: null,
          links: null,
          error: "skipped: CPU starved (host vCPUs withheld)",
        };
        failed++;
        results.push(result);
        console.log(`BENCH ${renderer} ${size}: SKIPPED (CPU starved)`);
        continue;
      }
      const fixtureFile = join(fixturesDir, `qllever-dev-${size}.json`);
      const doc = JSON.parse(readFileSync(fixtureFile, "utf8"));
      const options = {
        renderer,
        measureMs: MEASURE_MS,
        settleCapMs: SETTLE_CAP_MS,
        orbitPeriodMs: ORBIT_MS,
        ...(LAYOUT_ITER ? { layoutIterations: LAYOUT_ITER } : {}),
        width: 800,
        height: 600,
      };
      const pageHtml =
        "<!doctype html><html><body></body><script>window.__BENCH_OPTIONS__=" +
        JSON.stringify(options) +
        ";window.__BENCH_FIXTURE__=" +
        JSON.stringify({ nodes: doc.nodes, links: doc.links }) +
        ";window.__BENCH_WORKER_SRC__=" +
        JSON.stringify(workerSrc) +
        ";</script><script>" +
        harnessSrc +
        "</script></html>";

      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 700 });
      await page.bringToFront();
      const pageErrors = [];
      const benign = (msg) => /ResizeObserver loop/.test(msg);
      page.on("pageerror", (e) => {
        if (!benign(e.message))
          pageErrors.push(
            "pageerror: " +
              String(e.stack ?? e.message)
                .split("\n")
                .slice(0, 6)
                .join(" | ")
          );
      });
      page.on("console", (m) => {
        if (m.type() === "error" && !benign(m.text())) pageErrors.push("console: " + m.text());
        if (m.text().startsWith("[bench]")) console.log(`  [page] ${m.text()}`);
      });
      const shot = join(SHOT_DIR, `${renderer}-${size}.png`);
      const runStart = Date.now();
      let result;
      try {
        await page.setContent(pageHtml, { waitUntil: "load" });
        await page.waitForFunction("window.__BENCH_RESULT__ !== undefined", {
          timeout: TIMEOUT_MS,
        });
        result = await page.evaluate(() => window.__BENCH_RESULT__);
        await page.screenshot({ path: shot });
      } catch (err) {
        result = { renderer, error: `driver: ${String(err.message ?? err)}` };
      }
      let pageError = null;
      try {
        pageError = await page.evaluate(() => window.__BENCH_ERROR__ || null);
      } catch {
        /* page died with the browser */
      }
      try {
        await page.close();
      } catch {
        /* ditto */
      }

      const elapsed = Math.round((Date.now() - runStart) / 1000);
      if (pageErrors.length) result.pageErrors = pageErrors.slice(0, 5);
      if (pageError) result.pageError = pageError;
      result.screenshot = shot;
      result.wallClockS = elapsed;
      results.push(result);

      const ok = result && !result.error && result.frameCount > 0;
      if (!ok) failed++;
      console.log(
        `BENCH ${renderer} ${size}: ${
          ok
            ? `fps mean=${result.fpsMean} med=${result.fpsMedian} min=${result.fpsMin} ` +
              `frames=${result.frameCount}/${Math.round(MEASURE_MS / 16.7)} ` +
              `firstFrame=${result.firstFrameMs}ms settle=${result.settleMs}ms(${
                result.settled ? "cooled" : "capped"
              }) motion=${result.motionPx}px`
            : `FAILED ${result.error ?? "no result"}`
        } (${elapsed}s)${pageError ? ` pageError=${pageError}` : ""}`
      );
      for (const pe of result.pageErrors ?? []) console.log(`    ${pe}`);
    }
  }
} finally {
  try {
    await browser.close();
  } catch {
    /* already gone — results still get written below */
  }
}

if (!process.argv.includes("--screenshots")) rmSync(SHOT_DIR, { recursive: true, force: true });
if (OUT) {
  const env = {
    host: hostname(),
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    webgl: "SwiftShader (software) via headless Chromium",
    renderers: {
      fgraph3d: "react-force-graph-3d (three.js) — the app's current 3D view",
      sigma: "sigma v3 2D adapter + FA2 worker (D2)",
      cosmos: "cosmos.gl 2D GPU adapter (D3)",
    },
    measureMs: MEASURE_MS,
    settleCapMs: SETTLE_CAP_MS,
    orbitPeriodMs: ORBIT_MS,
    results,
  };
  writeFileSync(OUT, JSON.stringify(env, null, 2));
  console.log(`wrote ${OUT}`);
}

process.exit(failed === 0 ? 0 : 1);
