import { NODE_LIMIT_DEFAULT, NODE_LIMIT_MAX, NODE_LIMIT_MIN } from "@/engine/layout-utils";

export const NARROW = "(max-width: 767px)";

/** Read a remembered setting; `parse` returns undefined for invalid values (-> fallback). */
export function loadPref<T>(key: string, parse: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, raw: string): void {
  try {
    localStorage.setItem(key, raw);
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}

export const DEPTH_MIN = 1;
export const DEPTH_MAX = 8;
/** Backend default `max_hops`; requests with this depth omit the parameter (same cache key). */
export const DEPTH_DEFAULT = 6;
export const DEPTH_KEY = "hkg-depth";

export function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return DEPTH_DEFAULT;
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, Math.round(v)));
}

export const loadDepth = (): number =>
  loadPref(DEPTH_KEY, (r) => clampDepth(Number(r)), DEPTH_DEFAULT);
export const saveDepth = (v: number): void => savePref(DEPTH_KEY, String(v));

export const FANOUT_MIN = 0; // 0 = no cap
export const FANOUT_MAX = 100_000;
/** Backend default `max_fanout` (STREAM_FANOUT); requests with it omit the parameter. */
export const FANOUT_DEFAULT = 200;
export const FANOUT_KEY = "hkg-fanout";

export function clampFanout(v: number): number {
  if (!Number.isFinite(v)) return FANOUT_DEFAULT;
  return Math.min(FANOUT_MAX, Math.max(FANOUT_MIN, Math.round(v)));
}
export const loadFanout = (): number =>
  loadPref(FANOUT_KEY, (r) => (r === "" ? undefined : clampFanout(Number(r))), FANOUT_DEFAULT);
/** `max_fanout` request parameter: undefined for the backend default (prewarmed snapshots). */
export const fanoutParam = (v: number): number | undefined =>
  v === FANOUT_DEFAULT ? undefined : v;

/** `max_hops` request parameter for a depth: undefined for the backend default. */
export function depthToMaxHops(depth: number): number | undefined {
  return depth === DEPTH_DEFAULT ? undefined : depth;
}

/**
 * Shown nodes per group among the first `shown` nodes. Last slot = unclassified
 * (group -1 or out of range), so the result has `groupCount + 1` entries.
 */
export function groupCounts(groups: Int16Array, shown: number, groupCount: number): number[] {
  const out = new Array<number>(groupCount + 1).fill(0);
  const n = Math.min(shown, groups.length);
  for (let i = 0; i < n; i++) {
    const g = groups[i];
    out[g >= 0 && g < groupCount ? g : groupCount]++;
  }
  return out;
}

export const DIM_KEY = "hkg-dim";
export const ROOT_KEY = "hkg-root";

export const loadDim = (): 2 | 3 => loadPref(DIM_KEY, (r) => (r === "2" ? 2 : undefined), 3);

/** Remembered root IRI (any http(s) IRI, e.g. after a right-click re-root). */
export const loadRoot = (fallback: string): string =>
  loadPref(ROOT_KEY, (r) => (/^https?:\/\/\S+$/.test(r) ? r : undefined), fallback);

export const NODE_LIMIT_KEY = "hkg-node-limit";
export const loadNodeLimit = (): number =>
  loadPref(
    NODE_LIMIT_KEY,
    (r) => {
      const v = Number(r);
      return v >= NODE_LIMIT_MIN && v <= NODE_LIMIT_MAX ? v : undefined;
    },
    NODE_LIMIT_DEFAULT
  );
export const saveNodeLimit = (v: number): void => savePref(NODE_LIMIT_KEY, String(v));
