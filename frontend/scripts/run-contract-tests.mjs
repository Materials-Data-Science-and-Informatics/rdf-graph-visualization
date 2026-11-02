// Card D1 — runs the GraphRenderer contract test (render-contract.test.ts).
//
// Bundles the TS test with esbuild (the same esbuild Vite drives, resolved
// THROUGH vite so the runner works under pnpm's strict node_modules — esbuild
// is a transitive dependency and has no root node_modules link there) and
// executes the bundle with Node's built-in test runner. No test-framework
// dependency. Exits non-zero on any failure — `npm run test` mirrors that.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(frontend, "scripts", "render-contract.test.ts");

// esbuild is not a direct dependency; resolve its JS API from vite, which
// declares esbuild as a direct dependency in both npm and pnpm layouts.
const requireFromFrontend = createRequire(join(frontend, "package.json"));
const esbuild = createRequire(requireFromFrontend.resolve("vite"))("esbuild");

const outDir = mkdtempSync(join(tmpdir(), "render-contract-"));
const bundle = join(outDir, "render-contract.test.mjs");
let failed = 0;
try {
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
    outfile: bundle,
  });
  execFileSync(process.execPath, ["--test", bundle], { stdio: "inherit" });
} catch (err) {
  failed = typeof err.status === "number" && err.status !== 0 ? err.status : 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
process.exit(failed);
