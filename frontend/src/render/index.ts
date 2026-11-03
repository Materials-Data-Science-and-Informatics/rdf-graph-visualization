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
// Card D3 — cosmos.gl (`@cosmos.gl/graph`) adapter + its inspection surface.
export { createCosmosRenderer } from "./cosmos";
export type { CosmosRenderer } from "./cosmos";
// Card D2 — sigma 2D adapter, deterministic position seeding, engine
// registration (CONTRACT.md §7).
export { djb2, mulberry32, POSITION_SPAN, seedPosition2D } from "./seeding";
export { createSigmaRenderer, SIGMA_RENDERER_ID } from "./sigma";
export type {
  SigmaCameraState,
  SigmaLabelLodOptions,
  SigmaLayoutOptions,
  SigmaNodeLabelState,
  SigmaRenderer,
  SigmaRendererDiagnostics,
  SigmaRendererOptions,
} from "./sigma";
export { registerEngines } from "./engines";
// Card D2 S2 — force-atlas2 layout engine, worker entry, and the
// main-thread layout worker client (the sigma adapter's layout runs off the
// main thread; CONTRACT.md §2 layout ownership).
export {
  DEFAULT_FORCE_ATLAS2_SETTINGS,
  createForceAtlas2Session,
  runForceAtlas2,
} from "./forceatlas2";
export type { ForceAtlas2Input, ForceAtlas2Settings, ForceAtlas2Session } from "./forceatlas2";
export {
  LAYOUT_DEFAULT_ITERATIONS,
  LAYOUT_DEFAULT_ITERATIONS_PER_TICK,
  createLayoutWorker,
} from "./layout-worker";
export type { LayoutRequest, LayoutTick, LayoutWorkerClient } from "./layout-worker";
export type {
  LayoutIncomingMessage,
  LayoutStartMessage,
  LayoutStopMessage,
  LayoutTickMessage,
} from "./forceatlas2.worker";
