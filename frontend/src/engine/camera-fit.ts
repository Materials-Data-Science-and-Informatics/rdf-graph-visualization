import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { estimateRadius, type EngineConfig } from "./config";
import type { GpuGraph } from "./gpu-graph";
import { fitDistance, fitFromPositions } from "./layout-utils";
import type { Vec3 } from "./picking";

export const FOV = 60;
const FIT_EASE = 0.08;

/** What `updateFit` needs from the engine for the current frame. */
export interface FitContext {
  gpu: GpuGraph | null;
  renderer: THREE.WebGPURenderer;
  alpha: number;
  rebuilding: boolean;
  generation: number;
  /** True while a pending readback of `gpu` / `generation` still applies (not disposed, not replaced). */
  isCurrent(gpu: GpuGraph, generation: number): boolean;
}

/**
 * Camera + orbit controls and the auto-fit / focus / clip-plane state that drives them:
 * the camera frames the graph while it grows, until the user interacts.
 */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1e6);
  readonly controls: OrbitControls;
  dim: 2 | 3 = 3;
  fitting = true;
  fitCenter = new THREE.Vector3();
  fitValid = false; // true once a measured fit exists for this generation
  fitAfterFreeze = false;
  lastFitRead = 0;
  /** After a re-root: keep the orbit target on the (carried) root until the final fit. */
  anchored = false;
  anchorPending = false;
  private fitDist = 0;
  private fitBusy = false;
  /** Camera distance never drops below this until the final (post-freeze) fit; avoids zoom oscillation. */
  private distFloor = 0;
  private viewDir = new THREE.Vector3(0, 0, 1);
  private focusTarget: THREE.Vector3 | null = null;
  private focusDist = 0;
  /** Graph radius (world units) used for the clip planes and zoom limits; refined by the fit. */
  private graphRadius = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly cfg: EngineConfig
  ) {
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 1e5;
    this.controls.addEventListener("start", () => (this.fitting = false));
    this.setViewDir();
    this.camera.position.copy(this.viewDir).multiplyScalar(this.estimateDist(1));
  }

  estimateDist(nodeCount: number): number {
    return fitDistance(estimateRadius(this.cfg.rest, nodeCount), FOV);
  }

  /** Default orbit direction: +z, elevated by `viewElevationDeg` in 3D; straight on in 2D. */
  private setViewDir(): void {
    const e = this.dim === 2 ? 0 : THREE.MathUtils.degToRad(this.cfg.viewElevationDeg);
    this.viewDir.set(0, Math.sin(e), Math.cos(e));
  }

  /** 2D = z locked via uniform; camera looks straight down -z and left-drag pans (map-like). */
  applyDim(dim: 2 | 3): void {
    this.dim = dim;
    this.controls.enableRotate = dim === 3;
    this.controls.mouseButtons.LEFT = dim === 2 ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = dim === 2 ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }

  /** Re-frame the whole graph and resume auto-fit while the graph grows. */
  resetView(): void {
    this.fitting = true;
    this.distFloor = 0;
    this.anchored = false;
    this.setViewDir();
    const d = this.camera.position.distanceTo(this.controls.target) || this.estimateDist(1);
    this.camera.position.copy(this.controls.target).addScaledVector(this.viewDir, d);
    this.lastFitRead = 0; // measure again right away
  }

  /**
   * New stream generation: keep the orbit direction and distance (no jump); the fit only
   * grows the distance while streaming, optionally anchored on the carried root, with one
   * final fit at freeze.
   */
  resetForGeneration(anchorPending: boolean): void {
    this.focusTarget = null;
    this.fitValid = false;
    this.fitting = true;
    this.fitAfterFreeze = false;
    this.lastFitRead = 0;
    this.anchored = false;
    this.anchorPending = anchorPending;
    this.distFloor = this.camera.position.distanceTo(this.controls.target);
  }

  /** Keep the orbit target on the carried root of a re-rooted graph (while still auto-fitting). */
  anchorOn(root: Vec3 | undefined): void {
    if (root && this.fitting) {
      this.anchored = true;
      this.fitCenter.set(...root);
      if (this.dim === 2) this.fitCenter.z = 0;
    }
  }

  /** Smoothly move the orbit target to (x, y, z) (and zoom in if far away). */
  focusPoint(x: number, y: number, z: number): void {
    this.fitting = false;
    this.focusTarget = new THREE.Vector3(x, y, this.dim === 2 ? 0 : z);
    this.focusDist = Math.min(
      this.camera.position.distanceTo(this.controls.target),
      this.cfg.rest * 6
    );
  }

  /** The user takes over the camera: stop an ongoing focus animation. */
  releaseFocus(): void {
    this.focusTarget = null;
  }

  /**
   * Clip planes and zoom limits follow the current zoom every frame (fixed planes blacked
   * out the graph when zooming in past `near` or out past `far`).
   */
  updateClip(gpu: GpuGraph | null): void {
    const nodeR = gpu?.radius ?? this.cfg.rest / 6;
    const radius = Math.max(this.graphRadius, this.estimateDist(1) / 4, nodeR * 4);
    const dist = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.05, dist * 0.002);
    const far = dist + radius * 4;
    this.controls.minDistance = nodeR * 1.5;
    this.controls.maxDistance = Math.max(radius * 20, dist);
    const c = this.camera;
    if (Math.abs(near - c.near) > c.near * 0.05 || Math.abs(far - c.far) > c.far * 0.05) {
      c.near = near;
      c.far = far;
      c.updateProjectionMatrix();
    }
  }

  /** Ease the orbit target (camera shifts with it) towards `focusTarget`. */
  updateFocus(): void {
    const t = this.focusTarget;
    if (!t) return;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length() || this.focusDist;
    target.lerp(t, 0.12);
    offset.setLength(dist + (this.focusDist - dist) * 0.12);
    this.camera.position.copy(target).add(offset);
    if (
      target.distanceTo(t) < 1e-2 * Math.max(1, this.focusDist) &&
      Math.abs(dist - this.focusDist) < 1e-2 * this.focusDist
    ) {
      this.focusTarget = null;
    }
  }

  /**
   * Auto-fit until the user interacts: positions are read back from the GPU (active
   * nodes only) every `fitIntervalMs` while simulating and once after the freeze; the
   * centroid and 95th-percentile radius give the target and distance, eased per frame.
   */
  updateFit(now: number, ctx: FitContext): void {
    const gpu = ctx.gpu;
    if (!this.fitting || !gpu || gpu.nodeCount === 0) return;
    const due =
      this.fitAfterFreeze ||
      (!this.fitValid && now - this.lastFitRead >= 200) ||
      (ctx.alpha > 0 && now - this.lastFitRead >= this.cfg.fitIntervalMs) ||
      this.lastFitRead === 0;
    if (due && !this.fitBusy && !ctx.rebuilding) {
      this.fitBusy = true;
      const final = this.fitAfterFreeze;
      this.fitAfterFreeze = false;
      this.lastFitRead = now;
      const gen = ctx.generation;
      const count = gpu.nodeCount;
      gpu
        .readPositions(ctx.renderer, count)
        .then((pos) => {
          if (!ctx.isCurrent(gpu, gen)) return;
          const fit = fitFromPositions(pos, count, 4, this.cfg.fitPercentile);
          const radius = Math.max(fit.radius + gpu.radius, this.cfg.rest); // include sphere size
          let center: Vec3 = fit.center;
          let r = radius;
          if (final) this.anchored = false;
          else {
            // While growing/settling the aim holds still (the carried root after a re-root,
            // else the current target) and only the distance grows: chasing the moving
            // centroid swung the view. The final fit after the freeze re-centres once.
            const c = this.anchored ? this.fitCenter : this.controls.target;
            center = [c.x, c.y, c.z];
            r += Math.hypot(
              center[0] - fit.center[0],
              center[1] - fit.center[1],
              center[2] - fit.center[2]
            );
          }
          this.fitCenter.set(...center);
          if (this.dim === 2) this.fitCenter.z = 0;
          const d = fitDistance(r, FOV);
          const base = this.fitValid ? this.fitDist : this.distFloor;
          this.fitDist = final ? d : Math.max(d, base);
          this.fitValid = true;
          this.graphRadius = radius;
        })
        .catch((err: unknown) => console.warn("camera fit readback failed", err))
        .finally(() => (this.fitBusy = false));
    }
    const center = this.fitValid || this.anchored ? this.fitCenter : this.controls.target;
    const want = this.fitValid
      ? this.fitDist
      : Math.max(this.estimateDist(gpu.nodeCount), this.distFloor);
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const dist = offset.length() || want;
    target.lerp(center, FIT_EASE);
    offset.setLength(dist + (want - dist) * FIT_EASE);
    this.camera.position.copy(target).add(offset);
  }
}
