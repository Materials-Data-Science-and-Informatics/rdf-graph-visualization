// Runtime renderer config (card C4).
//
// Replaces the retired build-time `/config.yml?raw` import: the palette and
// property presets are fetched once at startup from `GET /api/config` (card
// B6 derives them from the pinned hkg_data_model) and installed into this
// module-level registry. Nothing about the config is baked into the bundle,
// so a config change on the serving backend (deployment ConfigMap → backend
// env) alters the rendered palette WITHOUT a frontend rebuild.
//
// Consumers:
//   - App.tsx gates the UI on loadConfig() so every render below sees the
//     live palette;
//   - getGroupColor(): Graph.tsx (node materials) + graph-store.ts
//     (toGraphData);
//   - getPaletteEntries(): Legend.tsx;
//   - getConfigSnapshot(): Layout.tsx ("Config" modal).

import { getConfig } from "./api/client";
import type { ConfigResponse } from "./api/types";

/**
 * Code-side fallback colour for groups missing from /api/config. "Unknown"
 * is deliberately NOT a preset (card B6), so Unknown-grouped nodes and any
 * future group drift render in this colour instead of crashing.
 */
export const FALLBACK_COLOR = "gray";

let palette = new Map<string, string>();
let entries: { group: string; color: string }[] = [];
let snapshot: ConfigResponse | null = null;

/**
 * Fetch /api/config and install it into the module registry. Safe to call
 * again (a reload re-fetches and re-installs). Returns the response.
 */
export async function loadConfig(signal?: AbortSignal): Promise<ConfigResponse> {
  const config = await getConfig({ signal });
  const next = new Map<string, string>();
  for (const preset of config.types) {
    if (!next.has(preset.group)) next.set(preset.group, preset.color);
  }
  palette = next;
  entries = [...next.entries()].map(([group, color]) => ({ group, color }));
  snapshot = config;
  return config;
}

/** Colour for a data-model group; groups missing from the config get gray. */
export function getGroupColor(group: string): string {
  return palette.get(group) ?? FALLBACK_COLOR;
}

/** Distinct group→colour palette entries in /api/config order (legend). */
export function getPaletteEntries(): { group: string; color: string }[] {
  return entries;
}

/** The raw /api/config response, once loaded (null before loadConfig()). */
export function getConfigSnapshot(): ConfigResponse | null {
  return snapshot;
}
