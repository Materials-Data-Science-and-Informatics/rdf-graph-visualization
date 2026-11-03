// Card D3 — driver for the cosmos.gl 2k-node render check (S1).
//
// 1. Bundles scripts/cosmos-render-check.ts for the browser (esbuild via
//    vite — the same resolution trick D1's contract runner uses).
// 2. Loads it into a headless Chromium with software WebGL (SwiftShader).
// 3. Waits for the harness's window.__COSMOS_RESULT__, asserts the 2,000
//    nodes drew to a non-blank canvas, and writes a screenshot.
//
// Needs `puppeteer-core` (NOT a project dependency — a verification tool) and
// a headless Chromium. Browser discovery order:
//   $PUPPETEER_EXECUTABLE_PATH → well-known local shells → puppeteer default.
// Screenshot path: $COSMOS_RENDER_SCREENSHOT (default: a temp file).
//
// Exit: 0 on a passing render, 1 on a render/assert failure, 2 if the
// verification tooling (puppeteer-core / a browser) is unavailable.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(frontend, "scripts", "cosmos-render-check.ts");
const outDir = mkdtempSync(join(tmpdir(), "cosmos-render-"));
const bundle = join(outDir, "cosmos-render-check.iife.js");
const screenshot = process.env.COSMOS_RENDER_SCREENSHOT || join(outDir, "cosmos-2k.png");
// S3 knobs: node count and whether to run the interaction phase after the
// first frame (resetView + focus fly-to + node-select + theme round trip).
const nodeCount = Number(process.env.COSMOS_RENDER_NODES || "2000");
const interactions = process.env.COSMOS_RENDER_INTERACTIONS !== "0";

// --- 1. bundle the harness -------------------------------------------------
const requireFromFrontend = createRequire(join(frontend, "package.json"));
const esbuild = createRequire(requireFromFrontend.resolve("vite"))("esbuild");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  logLevel: "warning",
  nodePaths: [join(frontend, "node_modules")],
  outfile: bundle,
});
const pageHtml =
  "<!doctype html><html><body></body><script>window.__COSMOS_OPTIONS__=" +
  JSON.stringify({ nodes: nodeCount, interactions }) +
  ";</script><script>" +
  readFileSync(bundle, "utf8") +
  "</script></html>";

// --- 2. locate a headless browser -----------------------------------------
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

// --- 3. drive it (puppeteer-core is a verification-only tool) --------------
let puppeteer;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch {
  console.error("cosmos-render-check: 'puppeteer-core' is not installed.");
  console.error(
    "This is a VERIFICATION tool, not an app dependency. Install it (e.g. `pnpm add -D puppeteer-core`) and a headless Chromium, then re-run."
  );
  process.exit(2);
}

let failed = 1;
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: browserExecutable, // undefined → puppeteer's default
    args: [
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-gpu",
      "--hide-scrollbars",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  const pageErrors = [];
  // Chrome logs "ResizeObserver loop …" as an error; benign, not a failure.
  const benign = (msg) => /ResizeObserver loop/.test(msg);
  page.on("pageerror", (e) => {
    if (!benign(e.message)) pageErrors.push("pageerror: " + e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !benign(m.text())) pageErrors.push("console: " + m.text());
  });
  await page.setContent(pageHtml, { waitUntil: "load" });
  await page.waitForFunction("window.__COSMOS_RESULT__ !== undefined", { timeout: 120000 });
  const result = await page.evaluate(() => window.__COSMOS_RESULT__);
  const pageError = await page.evaluate(() => window.__COSMOS_ERROR__ || null);
  await page.screenshot({ path: screenshot });

  const problems = [];
  if (result.nodes !== nodeCount) problems.push(`expected ${nodeCount} nodes, got ${result.nodes}`);
  if (result.headless) problems.push("adapter ran headless instead of constructing a GL engine");
  if (!result.canvas) problems.push("no canvas was created");
  if (result.nonBlackPx < 500)
    problems.push(`canvas non-blank pixels below threshold (${result.nonBlackPx} < 500)`);
  if (interactions) {
    const expected = [
      "resetView",
      "focus",
      "nodeSelect",
      "themeRoundTrip",
      "resetView-after-focus",
    ];
    if (!result.interactions) problems.push("interaction phase did not report");
    else {
      if (result.interactions.error)
        problems.push(`interaction phase failed: ${result.interactions.error}`);
      const performed = result.interactions.performed || [];
      for (const step of expected)
        if (!performed.includes(step)) problems.push(`interaction step missing: ${step}`);
    }
  }
  if (pageErrors.length) problems.push("page errors: " + pageErrors.join(" | "));
  if (pageError) problems.push("page error event: " + pageError);

  console.log("COSMOS_RENDER_RESULT " + JSON.stringify(result));
  if (problems.length) {
    console.error("COSMOS_RENDER_FAIL " + problems.join("; "));
    failed = 1;
  } else {
    console.log(`COSMOS_RENDER_PASS screenshot=${screenshot}`);
    failed = 0;
  }
} catch (err) {
  console.error("cosmos-render-check: " + String(err && err.message ? err.message : err));
  failed = browser ? 1 : 2;
} finally {
  if (browser) await browser.close();
}

// Keep the temp screenshot alive only when it is the caller-supplied path.
if (!process.env.COSMOS_RENDER_SCREENSHOT) rmSync(outDir, { recursive: true, force: true });
process.exit(failed);
