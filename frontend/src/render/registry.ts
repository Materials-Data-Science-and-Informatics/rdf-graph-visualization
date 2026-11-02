// Renderer adapter registry (card D1, CONTRACT.md §6).
//
// Maps an adapter id to a factory. The app asks the registry for a renderer
// (createRenderer / createDefaultRenderer), mounts it, and drives it through
// the GraphRenderer contract. The registry stores factories, never
// instances — each create* call returns a fresh, unmounted renderer.
//
// Default policy: the first registered renderer becomes the default unless
// `isDefault` is set explicitly; later registrations never steal the default.
// Unregistering the default falls back to the first remaining id (insertion
// order), or null when the registry is empty.

import type { RendererFactory } from "./renderer";

const factories = new Map<string, RendererFactory>();
let defaultId: string | null = null;

function assertValidId(id: string): void {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`renderer: id must be a non-empty string, got ${JSON.stringify(id)}`);
  }
}

/**
 * Register an adapter under `id`. Throws on an empty id or a duplicate id
 * (callers must unregister first — silent replacement has burned registries
 * before, and it would hide double-init bugs from D2/D3).
 */
export function registerRenderer(
  id: string,
  factory: RendererFactory,
  options: { isDefault?: boolean } = {}
): void {
  assertValidId(id);
  if (typeof factory !== "function") {
    throw new Error(`renderer: factory for "${id}" must be a function`);
  }
  if (factories.has(id)) {
    throw new Error(`renderer: "${id}" is already registered (unregister it first)`);
  }
  factories.set(id, factory);
  if (options.isDefault || defaultId === null) {
    defaultId = id;
  }
}

/** Remove an adapter. Returns false when the id was unknown. */
export function unregisterRenderer(id: string): boolean {
  if (!factories.delete(id)) return false;
  if (defaultId === id) {
    defaultId = factories.keys().next().value ?? null;
  }
  return true;
}

/** All registered ids, in insertion order. */
export function listRenderers(): string[] {
  return [...factories.keys()];
}

/** The default adapter id, or null when the registry is empty. */
export function defaultRendererId(): string | null {
  return defaultId;
}

/**
 * Create a fresh, unmounted renderer for `id`.
 * Throws when `id` is not registered.
 */
export function createRenderer(id: string): import("./renderer").GraphRenderer {
  const factory = factories.get(id);
  if (!factory) {
    throw new Error(
      `renderer: "${id}" is not registered (known: ${[...factories.keys()].join(", ") || "none"})`
    );
  }
  const renderer = factory();
  if (renderer.id !== id) {
    throw new Error(`renderer: factory for "${id}" returned instance with id "${renderer.id}"`);
  }
  return renderer;
}

/** Create a fresh, unmounted default renderer. Throws when registry is empty. */
export function createDefaultRenderer(): import("./renderer").GraphRenderer {
  const id = defaultId;
  if (id === null) {
    throw new Error("renderer: no renderers registered (no default available)");
  }
  return createRenderer(id);
}

/** Test-only: drop all registrations and the default. */
export function resetRendererRegistry(): void {
  factories.clear();
  defaultId = null;
}
