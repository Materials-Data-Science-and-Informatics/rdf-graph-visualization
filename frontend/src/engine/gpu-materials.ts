import * as THREE from "three/webgpu";
import {
  Discard,
  Fn,
  abs,
  cameraPosition,
  clamp,
  cross,
  dot,
  float,
  instanceIndex,
  length,
  max,
  min,
  normalize,
  positionGeometry,
  pow,
  sign,
  sqrt,
  uint,
  uv,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { TYPED_THRESHOLD } from "./curve";
import type { GpuBuffers, GpuUniforms } from "./gpu-buffers";

/** Instanced strip: (segments+1) columns x 2 rows, position.x = t along 0..1, y = -0.5/0.5 across. */
export function stripGeometry(segments: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const p: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k <= segments; k++) p.push(k / segments, -0.5, 0, k / segments, 0.5, 0);
  for (let k = 0; k < segments; k++) {
    const v = k * 2;
    idx.push(v, v + 2, v + 3, v, v + 3, v + 1);
  }
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}

type UintNode = THREE.Node<"uint">;

/** uint id -> RGBA8 colour (little-endian bytes), exact through an rgba8unorm target. */
const idColor = (id: UintNode) => {
  const byte = (shift: number) => float(id.shiftRight(uint(shift)).bitAnd(uint(255))).div(255);
  return vec4(byte(0), byte(8), byte(16), byte(24));
};

/** Per-instance sprite scale factor: 1 + 0.2 hovered + 0.35 selected (vertex stage). */
function highlightScale(u: GpuUniforms) {
  const hov = u.uHover.equal(instanceIndex).select(float(1), float(0));
  const sel = u.uSel.equal(instanceIndex).select(float(1), float(0));
  return float(1).add(hov.mul(0.2)).add(sel.mul(0.35));
}

/**
 * World-space vertex positions of the edge strips / arrowheads (see createEdgeMaterials)
 * plus the edge colour (relation colour, else theme grey).
 */
export function edgeShaders(bufs: GpuBuffers, u: GpuUniforms, forPick: boolean) {
  const { pos, colors, edgeIdx, edgeCol } = bufs;
  const { uRad, uCurv } = u;
  const i = instanceIndex;
  const ia = edgeIdx.element(i.mul(2));
  const ib = edgeIdx.element(i.mul(2).add(1));
  const a = pos.element(ia).xyz;
  const b = pos.element(ib).xyz;
  const ca = colors.element(ia);
  const cb = colors.element(ib);
  // an edge with a hidden endpoint collapses to a point (degenerate triangles draw nothing)
  const hidden = min(ca.w, cb.w).lessThan(0.5);
  const d = b.sub(a);
  const len = max(length(d), 1e-4);
  const dn = d.div(len);
  // control point: midpoint + cross(dir, up) * curvature * length (mirrors curve.ts edgePerp)
  const up = abs(dn.z)
    .greaterThan(0.99)
    .select(vec3(0, 1, 0), vec3(0, 0, 1));
  const perp = normalize(cross(dn, up).add(vec3(1e-6)));
  const ctrl = a
    .add(b)
    .mul(0.5)
    .add(perp.mul(uCurv.mul(len)));
  const ta = ctrl.sub(a); // = P'(0)/2
  const tb = b.sub(ctrl); // = P'(1)/2
  const bez = (u: typeof len) => {
    const v = float(1).sub(u);
    return a
      .mul(v.mul(v))
      .add(ctrl.mul(v.mul(u).mul(2)))
      .add(b.mul(u.mul(u)));
  };
  const tangent = (u: typeof len) => ta.mul(float(1).sub(u)).add(tb.mul(u));
  const sideAt = (u: typeof len, p: typeof a) =>
    normalize(cross(tangent(u), cameraPosition.sub(p)).add(vec3(1e-6)));
  // curve parameter of a point ~uRad away from either end, measured along the end
  // tangents (|P'(0)| = 2|ta|, |P'(1)| = 2|tb|)
  const tbLen2 = max(length(tb), 1e-4).mul(2);
  const uStart = clamp(uRad.div(max(length(ta), 1e-4).mul(2)), 0, 0.45);
  const uTip = float(1).sub(clamp(uRad.div(tbLen2), 0, 0.45));
  const arrowLen = clamp(len.sub(uRad.mul(2)), 0, uRad.mul(1.4)); // shrinks on very short edges
  const uBase = max(uTip.sub(arrowLen.div(tbLen2)), uStart);
  const hovE = u.uHoverEdge.equal(i);
  // picking strips are 3x wider; the hovered edge is drawn 2.5x wider
  const shaftW = uRad
    .mul(forPick ? 0.6 : 0.2)
    .mul(forPick ? float(1) : hovE.select(float(2.5), float(1)));
  const t = positionGeometry.x;
  const s = positionGeometry.y;
  const us = uStart.add(uBase.sub(uStart).mul(t));
  const ps = bez(us);
  const shaftPos = hidden.select(a, ps.add(sideAt(us, ps).mul(s.mul(shaftW))));
  const tipP = bez(uTip);
  const baseP = bez(uBase);
  const adir = normalize(tipP.sub(baseP).add(vec3(1e-6)));
  const aside = normalize(cross(adir, cameraPosition.sub(baseP)).add(vec3(1e-6)));
  const arrowW = forPick ? float(1.2) : hovE.select(float(1.3), float(0.8));
  const arrowPos = hidden.select(
    a,
    tipP.sub(adir.mul(arrowLen.mul(float(1).sub(t)))).add(aside.mul(s.mul(arrowLen).mul(arrowW)))
  );
  // colour: the relation's colour (w = 1), else theme grey
  const ec = edgeCol.element(i);
  const color = ec.w.greaterThan(0.5).select(ec.xyz, u.uEdgeColor as unknown as typeof a);
  return { shaftPos, arrowPos, color };
}

/** Node draw material: sphere/box impostor shaded in the fragment stage. */
export function createNodeMaterial(b: GpuBuffers, u: GpuUniforms): THREE.SpriteNodeMaterial {
  const mat = new THREE.SpriteNodeMaterial();
  mat.positionNode = b.pos.toAttribute().xyz;
  // sprite scale = diameter; hovered nodes grow 20%, the selected one gets room for a ring
  mat.scaleNode = u.uRad.mul(2).mul(highlightScale(u));
  mat.transparent = false;
  mat.depthWrite = true;
  const cAttr = b.colors.toAttribute();
  const { uHover, uSel, uRing } = u;
  mat.fragmentNode = Fn(() => {
    const hov = uHover.equal(instanceIndex).select(float(1), float(0));
    const sel = uSel.equal(instanceIndex).select(float(1), float(0));
    const k = float(1).add(sel.mul(0.35)).add(hov.mul(0.2)).div(hov.mul(0.2).add(1));
    // alpha: 0 hidden, UNTYPED_ALPHA visible without group (box), 1 visible typed (sphere)
    const box = cAttr.w.lessThan(TYPED_THRESHOLD);
    const q = uv().mul(2).sub(1);
    const rq2 = dot(q, q);
    const mq0 = max(abs(q.x), abs(q.y));
    Discard(cAttr.w.lessThan(0.5)); // group visibility (see applyVisibility)
    Discard(box.select(float(0), rq2.sub(1)).greaterThan(0));
    const qq = q.mul(k); // shape coordinates (shrunk inside the sprite when selected)
    const r2 = dot(qq, qq);
    const mqq = max(abs(qq.x), abs(qq.y));
    const outside = box.select(mqq.greaterThan(0.8), r2.greaterThan(1));
    const ringZone = box.select(
      sel.greaterThan(0.5).and(mq0.greaterThan(0.88)),
      rq2.greaterThanEqual(0.7744)
    );
    Discard(outside.and(ringZone.not())); // gap between shape and selection ring
    const z = sqrt(max(float(1).sub(r2), 0));
    // box: flat top with bevelled edges (normal tilts toward the nearest edge)
    const u = qq.div(0.8);
    const ax = abs(u.x);
    const ay = abs(u.y);
    const bev = (v: typeof ax) => clamp(v.sub(0.65).div(0.35), 0, 1).mul(1.2);
    const xDom = ax.greaterThanEqual(ay);
    const nx = xDom.select(bev(ax).mul(sign(u.x)), float(0));
    const ny = xDom.select(float(0), bev(ay).mul(sign(u.y)));
    const nrm = box.select(normalize(vec3(nx, ny, 1)), vec3(qq.x, qq.y, z));
    const L = normalize(vec3(-0.4, 0.6, 0.7));
    const diff = max(dot(nrm, L), 0);
    const spec = pow(max(dot(nrm, normalize(L.add(vec3(0, 0, 1)))), 0), 32)
      .mul(0.45)
      .mul(box.select(float(0.25), float(1)));
    const rim = box.select(float(0), pow(float(1).sub(z), 3).mul(0.35));
    const lit = cAttr.xyz.mul(diff.mul(0.85).add(0.3)).add(spec).add(rim).mul(hov.mul(0.35).add(1));
    return vec4(outside.select(uRing as unknown as typeof lit, lit), 1);
  })();
  return mat;
}

/** Shaft and arrowhead materials: endpoints come from the position buffer via the edge index buffer. */
export function createEdgeMaterials(b: GpuBuffers, u: GpuUniforms) {
  const matOpts = {
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  };
  const shaftMat = new THREE.MeshBasicNodeMaterial(matOpts);
  const arrowMat = new THREE.MeshBasicNodeMaterial(matOpts);
  const { shaftPos, arrowPos, color } = edgeShaders(b, u, false);
  shaftMat.positionNode = shaftPos;
  arrowMat.positionNode = arrowPos;
  const hovE = () => u.uHoverEdge.equal(instanceIndex);
  for (const [mat, op] of [
    [shaftMat, u.uShaftOp],
    [arrowMat, u.uArrowOp],
  ] as const) {
    mat.colorNode = Fn(() =>
      hovE().select(u.uHoverColor as unknown as typeof color, varying(color))
    )() as unknown as THREE.Node<"vec3">;
    mat.opacityNode = Fn(() => hovE().select(float(1), op))();
  }
  return { shaftMat, arrowMat };
}

/** Id-colour twins of the three draws, rendered on demand for GPU picking. */
export function createPickMaterials(b: GpuBuffers, u: GpuUniforms) {
  const pickBase = {
    transparent: false,
    depthWrite: true,
    blending: THREE.NoBlending,
    toneMapped: false,
  };
  const pickNodeMat = new THREE.SpriteNodeMaterial(pickBase);
  pickNodeMat.positionNode = b.pos.toAttribute().xyz;
  pickNodeMat.scaleNode = u.uRad.mul(2.4); // a bit generous: small nodes stay easy to hit
  const pAttr = b.colors.toAttribute();
  pickNodeMat.fragmentNode = Fn(() => {
    const q = uv().mul(2).sub(1);
    const pBox = pAttr.w.lessThan(TYPED_THRESHOLD);
    // untyped nodes are boxes: square hit area matching the 0.8 box (sprite is 2.4r here)
    Discard(pBox.select(max(abs(q.x), abs(q.y)).greaterThan(0.8), dot(q, q).greaterThan(1)));
    Discard(pAttr.w.lessThan(0.5));
    return idColor(instanceIndex.add(uint(1)));
  })();
  const edgePick = edgeShaders(b, u, true);
  const pickShaftMat = new THREE.MeshBasicNodeMaterial({ ...pickBase, side: THREE.DoubleSide });
  const pickArrowMat = new THREE.MeshBasicNodeMaterial({ ...pickBase, side: THREE.DoubleSide });
  pickShaftMat.positionNode = edgePick.shaftPos;
  pickArrowMat.positionNode = edgePick.arrowPos;
  const edgeId = Fn(() => idColor(instanceIndex.add(uint(1)).bitOr(uint(0x80000000))))();
  pickShaftMat.fragmentNode = edgeId;
  pickArrowMat.fragmentNode = edgeId;
  return { pickNodeMat, pickShaftMat, pickArrowMat };
}
