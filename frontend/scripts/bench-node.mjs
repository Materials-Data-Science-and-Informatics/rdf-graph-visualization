// Card D5 S2 — driver for the Node-side fps benchmark (scripts/bench-node.ts).
//
// 1. Bundles the layout WORKER entry (src/render/forceatlas2.worker.ts) for
//    node:worker_threads and the harness itself (esbuild, resolved through
//    vite — the same trick scripts/run-contract-tests.mjs uses under
//    pnpm's strict node_modules).
// 2. Runs the harness with --expose-gc (clean heap deltas) and passes the
//    worker bundle path through FORCEATLAS2_WORKER_PATH.
//
// No browser involved (owner directive 2026-11-03 disables browser checks
// for this card) — everything runs under Node.
//
// Usage (from the repo root or frontend/):
//   node scripts/bench-node.mjs [--sizes 5k,25k] [--reps 3] [--out FILE]
//
// Exit: 0 when every run produced a result, 1 when any run failed/was
// skipped, 2 when the tooling is unavailable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- args (passed through to the harness) -----------------------------------
const passthrough = [];
for (const name of ["sizes", "reps", "out"]) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1) passthrough.push(`--${name}`, process.argv[i + 1]);
}

// ---- bundle ---------------------------------------------------------------------
// esbuild is not a direct dependency; resolve its JS API from vite.
const requireFromFrontend = createRequire(join(frontend, "package.json"));
const esbuild = createRequire(requireFromFrontend.resolve("vite"))("esbuild");

const outDir = mkdtempSync(join(tmpdir(), "bench-node-"));
const workerBundle = join(outDir, "forceatlas2.worker.mjs");
const harnessBundle = join(outDir, "bench-node.mjs");
let failed = 0;
try {
  await esbuild.build({
    entryPoints: [join(frontend, "src/render/forceatlas2.worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    outfile: workerBundle,
  });
  await esbuild.build({
    entryPoints: [join(frontend, "scripts/bench-node.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    nodePaths: [join(frontend, "node_modules")],
    outfile: harnessBundle,
  });
  execFileSync(process.execPath, ["--expose-gc", harnessBundle, ...passthrough], {
    stdio: "inherit",
    env: {
      ...process.env,
      FORCEATLAS2_WORKER_PATH: workerBundle,
      BENCH_FRONTEND: frontend,
    },
  });
} catch (err) {
  failed = typeof err.status === "number" && err.status !== 0 ? err.status : 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(failed);
