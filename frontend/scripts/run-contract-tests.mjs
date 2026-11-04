// Card D1 (D2: multi-entry) — runs the headless contract suites.
//
// Bundles every scripts/*.test.ts with esbuild (the same esbuild Vite
// drives, resolved THROUGH vite so the runner works under pnpm's strict
// node_modules — esbuild is a transitive dependency and has no root
// node_modules link there) and executes the bundles with Node's built-in
// test runner. No test-framework dependency. Exits non-zero on any failure —
// `npm run test` mirrors that.
//
// Entries today: render-*.test.ts (D1 headless stub reference, D2 sigma
// adapter + FA2 engine/worker, D2 S3 label LOD, D2 S3 10k check) and
// filter-e4.test.ts (E4 class filter: slice re-query with ?type=, cursor
// chain carries the filter, legend/config palette consistency, URL keys).
// The cosmos suite (cosmos-contract.test.ts) has its own runner
// (run-cosmos-tests.mjs) and is excluded here.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptsDir = join(frontend, "scripts");
// All headless suites; the cosmos suite keeps its own runner (see header).
const entries = readdirSync(scriptsDir)
  .filter((f) => f.endsWith(".test.ts") && f !== "cosmos-contract.test.ts")
  .sort()
  .map((f) => join(scriptsDir, f));
if (entries.length === 0) {
  console.error("run-contract-tests: no scripts/*.test.ts entries found");
  process.exit(1);
}

// esbuild is not a direct dependency; resolve its JS API from vite, which
// declares esbuild as a direct dependency in both npm and pnpm layouts.
const requireFromFrontend = createRequire(join(frontend, "package.json"));
const esbuild = createRequire(requireFromFrontend.resolve("vite"))("esbuild");

const outDir = mkdtempSync(join(tmpdir(), "render-contract-"));
const bundles = entries.map((entry, i) => join(outDir, `render-contract.test.${i}.mjs`));
const workerBundle = join(outDir, "forceatlas2.worker.mjs");
let failed = 0;
try {
  // Worker entry first: the layout tests spawn it via node:worker_threads.
  await esbuild.build({
    entryPoints: [join(frontend, "src/render/forceatlas2.worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    outfile: workerBundle,
  });
  for (let i = 0; i < entries.length; i++) {
    await esbuild.build({
      entryPoints: [entries[i]],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "warning",
      outfile: bundles[i],
    });
  }
  execFileSync(process.execPath, ["--test", ...bundles], {
    stdio: "inherit",
    env: { ...process.env, FORCEATLAS2_WORKER_PATH: workerBundle },
  });
} catch (err) {
  failed = typeof err.status === "number" && err.status !== 0 ? err.status : 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(failed);
