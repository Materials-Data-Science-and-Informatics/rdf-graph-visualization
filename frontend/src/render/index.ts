// Card D1 — renderer contract, registry, and the headless stub adapter.
// The normative positions/state contract: CONTRACT.md (this directory).

export type {
  GraphRenderer,
  NodePosition,
  RendererFactory,
  RendererGraph,
  RendererLink,
  RendererNode,
} from "./renderer";
export {
  createDefaultRenderer,
  createRenderer,
  defaultRendererId,
  listRenderers,
  registerRenderer,
  resetRendererRegistry,
  unregisterRenderer,
} from "./registry";
export { createStubRenderer, seedPosition } from "./stub";
export type { StubRenderer } from "./stub";
// Card D2 — sigma 2D adapter, deterministic position seeding, engine
// registration (CONTRACT.md §7).
export { djb2, mulberry32, POSITION_SPAN, seedPosition2D } from "./seeding";
export { createSigmaRenderer, SIGMA_RENDERER_ID } from "./sigma";
export type { SigmaRenderer, SigmaRendererDiagnostics } from "./sigma";
export { registerEngines } from "./engines";
