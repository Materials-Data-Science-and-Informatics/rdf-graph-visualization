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
