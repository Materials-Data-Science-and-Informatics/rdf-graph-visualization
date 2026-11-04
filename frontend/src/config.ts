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
import type { ConfigResponse, NodeType } from "./api/types";

/**
 * Code-side fallback colour for groups missing from /api/config. "Unknown"
 * is deliberately NOT a preset (card B6), so Unknown-grouped nodes and any
 * future group drift render in this colour instead of crashing.
 */
export const FALLBACK_COLOR = "gray";

let palette = new Map<string, string>();
let entries: { group: string; type: NodeType; color: string }[] = [];
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
  entries = [...config.types].map((preset) => ({
    group: preset.group,
    type: preset.type,
    color: preset.color,
  }));
  snapshot = config;
  return config;
}

/** Colour for a data-model group; groups missing from the config get gray. */
export function getGroupColor(group: string): string {
  return palette.get(group) ?? FALLBACK_COLOR;
}

/**
 * Distinct group→colour palette entries in /api/config order. `group` is
 * the display label (legend), `type` the contract NodeType for filtering
 * (card E4 — they are equal for every preset the backend emits).
 */
export function getPaletteEntries(): { group: string; type: NodeType; color: string }[] {
  return entries;
}

/**
 * Card E4: normalize a raw URL `type` value to a contract NodeType. Only a
 * value that names a live palette group passes through — a stale shared
 * URL (model bump, typo) degrades to "all classes" (null) instead of a 422
 * on the very first slice. Must run after loadConfig() (App gates the UI
 * on the config load).
 */
export function typeFilterFromUrl(raw: string | null): NodeType | null {
  const match = entries.find((entry) => entry.group === raw);
  return match ? match.type : null;
}

/** The raw /api/config response, once loaded (null before loadConfig()). */
export function getConfigSnapshot(): ConfigResponse | null {
  return snapshot;
}
