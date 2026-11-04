// Card E1 — camera math for the fly-to jump.
//
// Pure vector ops (no three.js, no DOM) so the harness can pin the behaviour
// headless. The Graph component feeds the focused node's live coordinates
// (mutated in place by the force engine) and the current camera position;
// the result is passed to cameraPosition().

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Fallback view direction when the camera sits on the target (degenerate). */
const FALLBACK_DIRECTION: Vec3 = (() => {
  const v = { x: 0, y: 0.45, z: 1 };
  const len = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
})();

/**
 * Camera position for a fly-to: `distance` away from the node, along the
 * current view direction (camera → node reversed), so the jump keeps the
 * user's orientation instead of snapping to an arbitrary side. When camera
 * and node coincide (no defined direction) the fallback direction is used.
 */
export function flyCameraPosition(node: Vec3, camera: Vec3, distance: number): Vec3 {
  const dx = camera.x - node.x;
  const dy = camera.y - node.y;
  const dz = camera.z - node.z;
  const len = Math.hypot(dx, dy, dz);
  const dir = len < 1e-6 ? FALLBACK_DIRECTION : { x: dx / len, y: dy / len, z: dz / len };
  return {
    x: node.x + dir.x * distance,
    y: node.y + dir.y * distance,
    z: node.z + dir.z * distance,
  };
}

/** Euclidean distance (used by the re-aim loop's settle check). */
export function vecDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
