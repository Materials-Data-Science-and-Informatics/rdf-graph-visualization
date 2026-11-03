// Deterministic position seeding shared by the headless stub (D1) and the
// real engine adapters (D2 sigma, D3 cosmos.gl).
//
// CONTRACT.md §2 P3: new nodes must get defined, finite positions, and
// seeding from the node id must be deterministic so a full reload reproduces
// the layout (and so the D4 engine switch can re-seed identically).

/** djb2 — small, fast hash, good enough to seed a per-id PRNG. */
export function djb2(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return hash >>> 0;
}

/** mulberry32 — deterministic PRNG from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded positions land in [0, POSITION_SPAN) — a sane initial world size. */
export const POSITION_SPAN = 100;

/**
 * Deterministic 2D seed position for a node id: same id → same point.
 * (2D adapters, P6 — 3D adapters add a third dimension on top.)
 */
export function seedPosition2D(nodeId: string): { x: number; y: number } {
  const random = mulberry32(djb2(nodeId));
  return {
    x: random() * POSITION_SPAN,
    y: random() * POSITION_SPAN,
  };
}
