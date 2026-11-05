export const DEPTH_MIN = 1;
export const DEPTH_MAX = 8;
/** Backend default `max_hops`; requests with this depth omit the parameter (same cache key). */
export const DEPTH_DEFAULT = 6;
export const DEPTH_KEY = "hkg-depth";

export function clampDepth(v: number): number {
  if (!Number.isFinite(v)) return DEPTH_DEFAULT;
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, Math.round(v)));
}

export function loadDepth(): number {
  try {
    const raw = localStorage.getItem(DEPTH_KEY);
    return raw === null ? DEPTH_DEFAULT : clampDepth(Number(raw));
  } catch {
    return DEPTH_DEFAULT;
  }
}

export function saveDepth(v: number): void {
  try {
    localStorage.setItem(DEPTH_KEY, String(v));
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}

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

/** Curved edges default to on. */
export function loadCurved(): boolean {
  try {
    return localStorage.getItem(CURVED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveCurved(v: boolean): void {
  try {
    localStorage.setItem(CURVED_KEY, v ? "1" : "0");
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}
