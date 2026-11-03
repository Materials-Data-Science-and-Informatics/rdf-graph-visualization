// Card D2 — app-level renderer registration (D1 registry, CONTRACT.md §6/§7).
//
// The registry stores factories, not instances; the app registers the
// available engines once at startup, then asks for renderers through
// createDefaultRenderer()/createRenderer() (card D4's toggle does exactly
// that).
//
// Why npm `sigma` 3.0.0: the card says "sigma v3" and the sigma.js project's
// v3 release line is the `sigma` package v3.0.0 on npm (GitHub tag
// `sigma@3.0.0`, archive/v3 branch of jacomyal/sigma.js) — pinned exactly so
// the lockfile carries the 3.x line and not the 4.x maintenance line.

import { listRenderers, registerRenderer } from "./registry";
import { createSigmaRenderer, SIGMA_RENDERER_ID } from "./sigma";

/**
 * Register every engine the app ships. Idempotent: the registry throws on
 * duplicate ids, so already-registered ones are skipped. The sigma 2D
 * adapter is the first REAL adapter, so it opts into the default (R3).
 */
export function registerEngines(): void {
  const registered = new Set(listRenderers());
  if (!registered.has(SIGMA_RENDERER_ID)) {
    registerRenderer(SIGMA_RENDERER_ID, () => createSigmaRenderer(SIGMA_RENDERER_ID), {
      isDefault: true,
    });
  }
  // D3 will add the cosmos.gl 3D adapter here (it will NOT steal the
  // default — R3: the first registered renderer keeps it).
}
