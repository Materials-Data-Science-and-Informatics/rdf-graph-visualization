// Card D3 — runs the cosmos.gl adapter contract test (cosmos-contract.test.ts).
//
// Mirrors D1's run-contract-tests.mjs (esbuild-bundle the TS, run it with
// Node's built-in test runner — no test-framework dependency), pointed at the
// cosmos adapter suite. Kept as a separate runner (not merged into D1's) so
// the cosmos suite is independent of the other adapters' wiring while the
// render/ barrel is still being assembled by cards D2/D3 in parallel.
//
// Run: node scripts/run-cosmos-tests.mjs
// Exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(frontend, "scripts", "cosmos-contract.test.ts");

// esbuild is not a direct dependency; resolve its JS API from vite, which
// declares esbuild as a direct dependency in both npm and pnpm layouts.
const requireFromFrontend = createRequire(join(frontend, "package.json"));
const esbuild = createRequire(requireFromFrontend.resolve("vite"))("esbuild");

const outDir = mkdtempSync(join(tmpdir(), "cosmos-contract-"));
const bundle = join(outDir, "cosmos-contract.test.mjs");
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
