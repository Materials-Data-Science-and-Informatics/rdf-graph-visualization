// Card D2 S2 — force-atlas2 layout engine (pure, deterministic, 2D).
//
// Jécquier / Ainse / Venturini / Wang "Force Atlas 2" (2012), classic
// (non-linLog) mode with Barnes-Hut approximation, implemented WITHOUT any
// Math.random or wall-clock input: the same input always yields bit-identical
// output, which is what makes the layout reproducible across reloads (P3's
// spirit) and testable headless.
//
// Determinism notes:
//   - repulsion order is the node index order; the quadtree is rebuilt every
//     iteration in a fixed NW/NE/SW/SE visit order, so no iteration depends
//     on insertion history beyond node order;
//   - overlapping nodes get a fixed epsilon floor on distance (never 0/NaN);
//   - callers pass initial positions (the renderer's deterministic seeds);
//     the engine itself adds no jitter.
//
// The engine is transport-agnostic: forceatlas2.worker.ts runs it in a Web
// Worker (or node:worker_threads in tests) and ships positions back in
// chunks, so a 2k–10k layout never blocks the UI thread (card S3 relies on
// the main thread staying responsive while this runs).

export interface ForceAtlas2Settings {
  /** Repulsion/attraction strength multiplier (classic default: 1). */
  scalingRatio: number;
  /** Centripetal force strength, pulls nodes toward the origin (default 1). */
  gravity: number;
  /** Barnes-Hut approximation threshold (0 disables it; default 0.5). */
  barnesHutTheta: number;
  /** Minimum interaction distance (overlap floor; default 1e-3). */
  minDistance: number;
}

export const DEFAULT_FORCE_ATLAS2_SETTINGS: ForceAtlas2Settings = {
  scalingRatio: 1,
  gravity: 1,
  barnesHutTheta: 0.5,
  minDistance: 1e-3,
};

export interface ForceAtlas2Input {
  /** Node ids, in index order (index i ↔ positions[2i], positions[2i+1]). */
  nodes: readonly string[];
  /** Links as [sourceIndex, targetIndex] pairs. */
  links: ReadonlyArray<readonly [number, number]>;
  /** Mutable positions, length 2·nodes.length. Mutated in place. */
  positions: Float64Array;
}

/** Temperature schedule: starts at 100, cools linearly to 1. */
function temperature(iteration: number, iterations: number): number {
  const t = 100 * (1 - iteration / Math.max(iterations, 1));
  return Math.max(t, 1);
}

// ------------------------------------------------------------------ quadtree
//
// Bucketed Barnes-Hut: leaf cells hold up to MAX_PER_CELL points; a full leaf
// subdivides and redistributes. This design has no "one point per leaf"
// invariant, so exact-duplicate positions (e.g. a collapsed start) cannot
// cause unbounded subdivision — worst case is an overflow bucket (depth cap)
// whose points are iterated exactly, which is both correct and self-healing
// (the repulsion separates them on the next iteration).

const MAX_PER_CELL = 4;
const MAX_TREE_DEPTH = 32;

interface QuadCell {
  minX: number;
  minY: number;
  size: number;
  mass: number;
  comX: number;
  comY: number;
  count: number;
  /** Leaf bucket: node indices. Empty for internal cells. */
  items: number[];
  /** Set when subdivided (items is then empty). */
  children: [QuadCell | null, QuadCell | null, QuadCell | null, QuadCell | null] | null;
}

function newCell(minX: number, minY: number, size: number): QuadCell {
  return {
    minX,
    minY,
    size,
    mass: 0,
    comX: 0,
    comY: 0,
    count: 0,
    items: [],
    children: null,
  };
}

function childIndex(cell: QuadCell, x: number, y: number): number {
  const half = cell.size / 2;
  return (x >= cell.minX + half ? 1 : 0) | (y >= cell.minY + half ? 2 : 0);
}

/**
 * Insert node `idx` (position read from `pos`) into the tree. Always
 * terminates: at most one re-partition cascade per insert, depth-capped;
 * past the cap (or once the cell size underflows to 0) points simply
 * overflow the bucket, which cellForce iterates exactly.
 */
function insertAt(cell: QuadCell, idx: number, pos: Float64Array): void {
  let node = cell;
  let depth = 0;
  while (node.children) {
    node = node.children[childIndex(node, pos[2 * idx], pos[2 * idx + 1])] as QuadCell;
    depth++;
  }
  if (node.items.length < MAX_PER_CELL) {
    node.items.push(idx);
    return;
  }
  node.items.push(idx);
  repartition(node, pos, depth);
}

/**
 * Re-partition a full leaf bucket as ONE group (no per-item re-insertion —
 * that is what makes coincident points cheap: each insert pays at most one
 * depth-capped cascade, never one cascade per displaced item).
 */
function repartition(cell: QuadCell, pos: Float64Array, depth: number): void {
  if (cell.items.length <= MAX_PER_CELL) return;
  if (depth >= MAX_TREE_DEPTH || cell.size <= 0) return; // overflow bucket
  const groups: number[][] = [[], [], [], []];
  for (const j of cell.items) {
    groups[childIndex(cell, pos[2 * j], pos[2 * j + 1])].push(j);
  }
  const half = cell.size / 2;
  cell.children = [
    newCell(cell.minX, cell.minY, half), // NW
    newCell(cell.minX + half, cell.minY, half), // NE
    newCell(cell.minX, cell.minY + half, half), // SW
    newCell(cell.minX + half, cell.minY + half, half), // SE
  ];
  cell.items = [];
  for (let q = 0; q < 4; q++) {
    if (!groups[q].length) continue;
    const child = cell.children[q] as QuadCell;
    child.items.push(...groups[q]);
    repartition(child, pos, depth + 1);
  }
}

/** Bottom-up mass/centre-of-mass aggregation. */
function accumulate(cell: QuadCell, pos: Float64Array, mass: Float64Array): void {
  if (cell.children) {
    let m = 0;
    let mxx = 0;
    let mxy = 0;
    let count = 0;
    for (const c of cell.children) {
      if (c && c.count > 0) {
        accumulate(c, pos, mass);
        m += c.mass;
        mxx += c.comX * c.mass;
        mxy += c.comY * c.mass;
        count += c.count;
      }
    }
    cell.mass = m;
    cell.count = count;
    cell.comX = m > 0 ? mxx / m : 0;
    cell.comY = m > 0 ? mxy / m : 0;
    return;
  }
  let m = 0;
  let mxx = 0;
  let mxy = 0;
  for (const j of cell.items) {
    m += mass[j];
    mxx += pos[2 * j] * mass[j];
    mxy += pos[2 * j + 1] * mass[j];
  }
  cell.mass = m;
  cell.count = cell.items.length;
  cell.comX = m > 0 ? mxx / m : 0;
  cell.comY = m > 0 ? mxy / m : 0;
}

/**
 * Apply the repulsion from `cell` onto node `idx`, using the Barnes-Hut
 * approximation when the cell is far enough away (size/dist < theta) and
 * iterating bucket items exactly otherwise. A bucket that contains `idx` is
 * always iterated exactly (a COM approximation would include the node in
 * itself).
 */
function cellForce(
  cell: QuadCell,
  idx: number,
  pos: Float64Array,
  mass: Float64Array,
  theta: number,
  minDistance: number,
  fx: Float64Array,
  fy: Float64Array
): void {
  if (cell.count === 0) return;
  const x = pos[2 * idx];
  const y = pos[2 * idx + 1];
  const dx = cell.comX - x;
  const dy = cell.comY - y;
  const dist = Math.max(Math.sqrt(dx * dx + dy * dy), minDistance);
  if (!cell.children && cell.items.length > 0 && cell.items.includes(idx)) {
    // We are inside our own bucket: exact iteration over the other items.
    applyBucketExact(cell, idx, pos, mass, minDistance, fx, fy);
    return;
  }
  if (cell.size / dist < theta) {
    if (cell.mass > 0) {
      const f = (cell.mass * mass[idx]) / dist;
      fx[idx] -= (f * dx) / dist;
      fy[idx] -= (f * dy) / dist;
    }
    return;
  }
  if (cell.children) {
    for (const c of cell.children) {
      if (c) cellForce(c, idx, pos, mass, theta, minDistance, fx, fy);
    }
  } else {
    applyBucketExact(cell, idx, pos, mass, minDistance, fx, fy);
  }
}

/** Exact repulsion contribution of every other node in a leaf bucket. */
function applyBucketExact(
  cell: QuadCell,
  idx: number,
  pos: Float64Array,
  mass: Float64Array,
  minDistance: number,
  fx: Float64Array,
  fy: Float64Array
): void {
  const x = pos[2 * idx];
  const y = pos[2 * idx + 1];
  const mi = mass[idx];
  for (const j of cell.items) {
    if (j === idx) continue;
    const dx = pos[2 * j] - x;
    const dy = pos[2 * j + 1] - y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), minDistance);
    const f = (mass[j] * mi) / dist;
    fx[idx] -= (f * dx) / dist;
    fy[idx] -= (f * dy) / dist;
  }
}

// -------------------------------------------------------------------- engine

export interface ForceAtlas2Session {
  readonly nodeCount: number;
  /** Current iteration (0-based, count of completed iterations). */
  readonly iteration: number;
  readonly totalIterations: number;
  readonly positions: Float64Array;
  /** Run up to `n` more iterations. Returns true when the session is done. */
  step(n: number): boolean;
}

/**
 * Create a chunkable layout session. `positions` is mutated in place; read it
 * back after `step()` calls. The session is pure: no timers, no globals.
 */
export function createForceAtlas2Session(
  input: ForceAtlas2Input,
  iterations = 300,
  settings: Partial<ForceAtlas2Settings> = {}
): ForceAtlas2Session {
  const cfg = { ...DEFAULT_FORCE_ATLAS2_SETTINGS, ...settings };
  const n = input.nodes.length;
  if (input.positions.length < 2 * n) {
    throw new Error(`forceAtlas2: expected 2*${n} position values, got ${input.positions.length}`);
  }
  const pos = input.positions;
  const links = input.links;

  // Degree (mass), in+out, matching the classic paper's m_i.
  const mass = new Float64Array(n);
  for (const [s, t] of links) {
    if (s < 0 || s >= n || t < 0 || t >= n) {
      throw new Error(`forceAtlas2: link index out of range (${s}→${t})`);
    }
    mass[s] += 1;
    mass[t] += 1;
  }

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  // The paper operates in "centered space": the mass-weighted centre of mass
  // starts at the origin, which makes the gravity term a true invariant
  // (Σ F_g = 0) and skips an initial whole-graph collapse toward (0,0).
  if (n > 0) {
    let totalMass = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      totalMass += mass[i];
      cx += pos[2 * i] * mass[i];
      cy += pos[2 * i + 1] * mass[i];
    }
    if (totalMass > 0) {
      cx /= totalMass;
      cy /= totalMass;
    } else {
      // No edges at all: fall back to the plain mean.
      cx = 0;
      cy = 0;
      for (let i = 0; i < n; i++) {
        cx += pos[2 * i];
        cy += pos[2 * i + 1];
      }
      cx /= n;
      cy /= n;
    }
    for (let i = 0; i < n; i++) {
      pos[2 * i] -= cx;
      pos[2 * i + 1] -= cy;
    }
  }

  let iteration = 0;

  function buildTree(): QuadCell | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return null; // empty graph
    const size = Math.max(maxX - minX, maxY - minY, 1e-9);
    const root = newCell(minX - size / 2, minY - size / 2, size * 2);
    for (let i = 0; i < n; i++) insertAt(root, i, pos);
    accumulate(root, pos, mass);
    return root;
  }

  function runOneIteration(): void {
    fx.fill(0);
    fy.fill(0);

    // 1) Repulsion (Barnes-Hut over degree mass).
    const root = buildTree();
    if (root) {
      for (let i = 0; i < n; i++) {
        if (mass[i] > 0) cellForce(root, i, pos, mass, cfg.barnesHutTheta, cfg.minDistance, fx, fy);
      }
    }

    // 2) Attraction along links (FA2: magnitude ∝ distance, scaled by the
    //    endpoint degrees — outbound distribution: divide by your own degree).
    //    dx/dy already carry the distance, so no extra dist factor here.
    for (let e = 0; e < links.length; e++) {
      const s = links[e][0];
      const t = links[e][1];
      const dx = pos[2 * t] - pos[2 * s];
      const dy = pos[2 * t + 1] - pos[2 * s + 1];
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), cfg.minDistance);
      const f = (cfg.scalingRatio * dist * mass[t]) / Math.max(mass[s], 1);
      const g = (cfg.scalingRatio * dist * mass[s]) / Math.max(mass[t], 1);
      fx[s] += (f * dx) / dist;
      fy[s] += (f * dy) / dist;
      fx[t] -= (g * dx) / dist;
      fy[t] -= (g * dy) / dist;
    }

    // 3) Gravity toward the origin, ∝ mass.
    if (cfg.gravity > 0) {
      for (let i = 0; i < n; i++) {
        const g = cfg.gravity * mass[i];
        fx[i] -= g * pos[2 * i];
        fy[i] -= g * pos[2 * i + 1];
      }
    }

    // 4) Integrate with temperature clamp.
    const temp = temperature(iteration, iterations);
    for (let i = 0; i < n; i++) {
      let dx = fx[i] * cfg.scalingRatio;
      let dy = fy[i] * cfg.scalingRatio;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > temp) {
        dx = (dx / d) * temp;
        dy = (dy / d) * temp;
      }
      pos[2 * i] += dx;
      pos[2 * i + 1] += dy;
    }
    iteration++;
  }

  return {
    get nodeCount() {
      return n;
    },
    get iteration() {
      return iteration;
    },
    get totalIterations() {
      return iterations;
    },
    get positions() {
      return pos;
    },
    step(count: number): boolean {
      for (let i = 0; i < count && iteration < iterations; i++) runOneIteration();
      return iteration >= iterations;
    },
  };
}

/** Run the full layout to completion (convenience for tests / small graphs). */
export function runForceAtlas2(
  input: ForceAtlas2Input,
  iterations = 300,
  settings: Partial<ForceAtlas2Settings> = {}
): Float64Array {
  const session = createForceAtlas2Session(input, iterations, settings);
  session.step(iterations);
  return session.positions;
}
