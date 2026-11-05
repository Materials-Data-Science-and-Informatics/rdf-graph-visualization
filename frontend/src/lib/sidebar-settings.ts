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

const parseBool = (raw: string): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined;

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

export const CURVED_KEY = "hkg-curved-edges";

export const ARROWS_KEY = "hkg-arrows";
export const DIM_KEY = "hkg-dim";
export const EDGE_OPACITY_KEY = "hkg-edge-opacity";
export const ROOT_KEY = "hkg-root";
export const EDGE_OPACITY_MIN = 0.1;
export const EDGE_OPACITY_MAX = 2;

export const saveBool = (key: string, v: boolean): void => savePref(key, v ? "1" : "0");
/** Curved edges and arrows default to on. */
export const loadCurved = (): boolean => loadPref(CURVED_KEY, parseBool, true);
export const loadArrows = (): boolean => loadPref(ARROWS_KEY, parseBool, true);
export const loadDim = (): 2 | 3 => loadPref(DIM_KEY, (r) => (r === "2" ? 2 : undefined), 3);

export const loadEdgeOpacity = (): number =>
  loadPref(
    EDGE_OPACITY_KEY,
    (r) => {
      const v = Number(r);
      return r !== "" && v >= EDGE_OPACITY_MIN && v <= EDGE_OPACITY_MAX ? v : undefined;
    },
    1
  );

/** Remembered root IRI (any http(s) IRI, e.g. after a right-click re-root). */
export const loadRoot = (fallback: string): string =>
  loadPref(ROOT_KEY, (r) => (/^https?:\/\/\S+$/.test(r) ? r : undefined), fallback);
