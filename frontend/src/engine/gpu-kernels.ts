import {
  If,
  Loop,
  dot,
  float,
  hash,
  instanceIndex,
  length,
  max,
  min,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import type { EngineConfig } from "./config";
import { kernel, type GpuBuffers, type GpuUniforms } from "./gpu-buffers";

/** Force step kernel (stochastic repulsion + ring samples + springs + gravity). */
export function buildStep(b: GpuBuffers, u: GpuUniforms, cfg: EngineConfig, nodeCap: number) {
  const { pos, vel, offsets, neigh } = b;
  const { uCount, uCountF, uSeed, uZOn, uAlpha, uRepK, uSettled, uOldMob } = u;
  const k = cfg.samples;
  const ring = cfg.ringSamples;
  const rest = uniform(cfg.rest);
  const spring = uniform(cfg.spring);
  const grav = uniform(cfg.gravity);
  const damp = uniform(1 - cfg.velocityDecay);
  const eps = uniform(cfg.epsilon);
  const strength = uniform(cfg.repulsion);
  const clamp = uniform(cfg.speedClamp * cfg.rest);
  // Loose upstream typings (Node vs. swizzle chains): everything below is plain TSL.
  return kernel(() => {
    const idx = instanceIndex;
    If(idx.lessThan(uCount), () => {
      const pi = pos.element(idx).xyz.toVar();
      const vi = vel.element(idx).xyz.toVar();
      const f = vec3(0).toVar();
      // stochastic repulsion: K random samples, fixed per node (idx, sample, seed; no frame
      // term) so the equilibrium is stable, scaled by n/K
      Loop(k, ({ i }) => {
        const h = hash(
          idx
            .mul(uint(1664525))
            .add(uint(i).mul(uint(1013904223)))
            .add(uSeed.mul(uint(747796405)))
        );
        // h in [0,1): map to [0.5, n-0.5) so truncation stays inside [0, n-1] without a clamp
        const j = h.mul(uCountF.sub(1)).add(0.5).toUint();
        const d = pi.sub(pos.element(j).xyz);
        const r2 = dot(d, d).add(eps);
        f.addAssign(d.mul(uRepK).div(r2)); // d3 charge: |F| ~ 1/d
      });
      // 2-hop ring samples: a neighbour's random neighbour (weight 1) keeps the local
      // neighbourhood spread out, which the n/K random samples rarely reach
      const s = offsets.element(idx);
      const e = offsets.element(idx.add(1));
      If(e.greaterThan(s), () => {
        Loop(ring, ({ i }) => {
          const h1 = hash(
            idx
              .mul(uint(2654435761))
              .add(uint(i).mul(uint(40503)))
              .add(uSeed)
          );
          const nb = neigh.element(s.add(h1.mul(float(e.sub(s))).toUint()));
          const ns = offsets.element(nb);
          const ne = offsets.element(nb.add(1));
          const h2 = hash(
            idx
              .mul(uint(97))
              .add(uint(i).mul(uint(7919)))
              .add(uSeed.add(uint(13)))
          );
          const j = neigh.element(ns.add(h2.mul(float(ne.sub(ns))).toUint()));
          const d = pi.sub(pos.element(j).xyz);
          const r2 = max(dot(d, d), eps);
          If(j.notEqual(idx), () => {
            f.addAssign(d.mul(strength).div(r2));
          });
        });
      });
      // springs, d3 forceLink: strength 1/min(deg), the lower-degree node takes the bigger share
      const di = max(float(e.sub(s)), 1);
      Loop({ start: s, end: e, type: "uint", condition: "<" }, ({ i }) => {
        const j = neigh.element(i);
        const dj = max(float(offsets.element(j.add(1)).sub(offsets.element(j))), 1);
        const d = pos.element(j).xyz.sub(pi);
        const dist = max(length(d), 1e-3);
        const share = dj.div(di.add(dj));
        f.addAssign(d.div(dist).mul(dist.sub(rest)).mul(spring).mul(share).div(min(di, dj)));
      });
      f.subAssign(pi.mul(grav)); // centering
      // nodes that predate the current re-heat move at a fraction of the force
      const mob = idx.lessThan(uSettled).select(uOldMob, float(1));
      vi.addAssign(f.mul(uAlpha).mul(mob));
      vi.mulAssign(damp);
      vi.z.mulAssign(uZOn);
      vi.mulAssign(min(float(1), clamp.div(max(length(vi), 1e-6)))); // speed clamp
      pi.addAssign(vi);
      pi.z.assign(pi.z.mul(uZOn));
      pos.element(idx).assign(vec4(pi, 1));
      vel.element(idx).assign(vec4(vi, 0));
    });
  }, nodeCap);
}

/** Spawn kernel: pos = pos[anchor] + jitter (or origin + jitter), vel = 0, for [initStart, initEnd). */
export function buildInit(b: GpuBuffers, u: GpuUniforms, nodeCap: number) {
  const { pos, vel, initInfo } = b;
  const { uInitStart, uInitEnd, uFrame, uZOn } = u;
  return kernel(() => {
    const idx = instanceIndex;
    If(idx.greaterThanEqual(uInitStart).and(idx.lessThan(uInitEnd)), () => {
      const info = initInfo.element(idx);
      // info.z = 1: carried-over position (already uploaded), keep it and only zero the velocity
      If(info.z.lessThan(0.5), () => {
        const base = vec3(0).toVar();
        If(info.x.greaterThanEqual(0), () => {
          base.assign(pos.element(info.x.toUint()).xyz);
        });
        const seed = idx.add(uFrame.mul(7919));
        const rnd = vec3(hash(seed.mul(3)), hash(seed.mul(5).add(1)), hash(seed.mul(11).add(2)))
          .mul(2)
          .sub(1);
        const p = base.add(rnd.mul(info.y)).toVar();
        p.z.mulAssign(uZOn);
        pos.element(idx).assign(vec4(p, 1));
      });
      vel.element(idx).assign(vec4(0, 0, 0, 0));
    });
  }, nodeCap);
}
