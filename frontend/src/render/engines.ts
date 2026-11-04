// Card D2 — app-level renderer registration (D1 registry, CONTRACT.md §6/§7).
// Card D4 — the second engine (cosmos.gl) joins the registry so the app can
// toggle between them (CONTRACT.md §2 P5/P7 handoff; the toggle UI lives in
// components/Graph.tsx + components/EngineToggle.tsx).
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
import { createCosmosRenderer, COSMOS_RENDERER_ID } from "./cosmos";
import { createCosmos3dRenderer, COSMOS3D_RENDERER_ID } from "./cosmos3d";
import { createSigmaRenderer, SIGMA_RENDERER_ID } from "./sigma";

/**
 * Register every engine the app ships. Idempotent: the registry throws on
 * duplicate ids, so already-registered ones are skipped. The sigma 2D
 * adapter is the first REAL adapter, so it opts into the default (R3); the
 * cosmos 2D-GPU adapter registers AFTER it and does NOT steal the default —
 * it is an explicit opt-in of the renderer toggle (R3).
 */
export function registerEngines(): void {
  const registered = new Set(listRenderers());
  if (!registered.has(SIGMA_RENDERER_ID)) {
    registerRenderer(SIGMA_RENDERER_ID, () => createSigmaRenderer(SIGMA_RENDERER_ID), {
      isDefault: true,
    });
  }
  if (!registered.has(COSMOS_RENDERER_ID)) {
    registerRenderer(COSMOS_RENDERER_ID, () => createCosmosRenderer(COSMOS_RENDERER_ID));
  }
  // Owner directive: the SHOWCASE default is cosmos.gl in its native 3D
  // (live GPU forces, orbit camera). Registered last with isDefault so it
  // takes the default from sigma without disturbing the others.
  if (!registered.has(COSMOS3D_RENDERER_ID)) {
    registerRenderer(COSMOS3D_RENDERER_ID, () => createCosmos3dRenderer(COSMOS3D_RENDERER_ID), {
      isDefault: true,
    });
  }
}
