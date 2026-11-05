import {
  CLICK_MAX_MOVE_PX,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_PX,
  TOUCH_TAP_MAX_MS,
  classifyPointer,
  type PickHit,
  type PointerSample,
} from "./picking";

const HOVER_INTERVAL_MS = 33;
const LONG_PRESS_MS = 600;

/** Client-space pointer position. */
export interface PointerAt {
  x: number;
  y: number;
}

/**
 * Picking callbacks. `hit` is null over empty space; node hits carry the store index.
 * `onClick` = left click / tap, `onContextMenu` = right click / long-press.
 */
export interface EngineHandlers {
  onHover?: (hit: PickHit | null, at: PointerAt) => void;
  onClick?: (hit: PickHit | null, at: PointerAt) => void;
  onContextMenu?: (hit: PickHit | null, at: PointerAt) => void;
}

/** What the pointer input needs from the engine. */
export interface PointerHost {
  handlers(): EngineHandlers;
  pickAt(x: number, y: number): Promise<PickHit | null>;
  focusOn(index: number): void;
  /** Stream generation (a hover pick resolving after a reset is dropped). */
  generation(): number;
  /** The user takes over the camera: stop an ongoing focus animation. */
  releaseFocus(): void;
  /** The hover hit changed: refresh the GPU highlight. */
  applyHighlight(): void;
}

/** Canvas pointer handling: click / long-press / double-tap classification and throttled hover picking. */
export class PointerInput {
  hoverHit: PickHit | null = null;
  private hoverPos: PointerAt | null = null; // client coords of the latest pointer move
  private hoverDirty = false;
  private hoverBusy = false;
  private lastHoverPick = 0;
  private down: (PointerSample & { button: number; touch: boolean }) | null = null;
  private readonly pointers = new Set<number>();
  private longTimer: ReturnType<typeof setTimeout> | undefined;
  private longFired = false;
  private readonly unbind: (() => void)[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly host: PointerHost
  ) {
    this.bind(canvas);
  }

  /** Per frame: run the throttled hover pick when the pointer moved. */
  tick(now: number): void {
    if (this.hoverDirty && !this.hoverBusy && now - this.lastHoverPick >= HOVER_INTERVAL_MS) {
      this.hoverDirty = false;
      this.lastHoverPick = now;
      this.pickHover();
    }
  }

  clearHover(): void {
    this.hoverDirty = false;
    this.hoverPos = null;
    if (!this.hoverHit) return;
    this.hoverHit = null;
    this.host.applyHighlight();
    this.host.handlers().onHover?.(null, { x: 0, y: 0 });
  }

  dispose(): void {
    clearTimeout(this.longTimer);
    this.unbind.forEach((u) => u());
  }

  private pickHover(): void {
    const at = this.hoverPos;
    if (!at) return;
    this.hoverBusy = true;
    const gen = this.host.generation();
    this.host
      .pickAt(at.x, at.y)
      .then((hit) => {
        if (gen !== this.host.generation() || !this.hoverPos) return;
        const prev = this.hoverHit;
        const same = prev?.kind === hit?.kind && prev?.index === hit?.index;
        if (same && hit) return;
        if (!hit && !prev) return;
        this.hoverHit = hit;
        this.host.applyHighlight();
        this.host.handlers().onHover?.(hit, this.hoverPos ?? at);
      })
      .catch((err: unknown) => console.warn("pick failed", err))
      .finally(() => (this.hoverBusy = false));
  }

  private bind(canvas: HTMLCanvasElement): void {
    const host = this.host;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void
    ) => {
      canvas.addEventListener(type, fn);
      this.unbind.push(() => canvas.removeEventListener(type, fn));
    };
    const cancelLong = () => clearTimeout(this.longTimer);
    let lastTap: PointerSample | null = null;
    const resetPointers = () => {
      this.pointers.clear();
      this.down = null;
      cancelLong();
    };
    window.addEventListener("blur", resetPointers);
    this.unbind.push(() => window.removeEventListener("blur", resetPointers));
    on("lostpointercapture", (e) => this.pointers.delete(e.pointerId));
    on("wheel", () => host.releaseFocus());
    const sample = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: performance.now() });
    const fire = (kind: "onClick" | "onContextMenu", at: PointerAt) =>
      void host
        .pickAt(at.x, at.y)
        .then((hit) => host.handlers()[kind]?.(hit, at))
        .catch((err: unknown) => console.warn("pick failed", err));

    on("pointerdown", (e) => {
      this.pointers.add(e.pointerId);
      host.releaseFocus(); // user takes over the camera
      this.clearHover();
      cancelLong();
      if (this.pointers.size > 1) {
        this.down = null; // multi-touch = camera gesture
        return;
      }
      this.down = { ...sample(e), button: e.button, touch: e.pointerType === "touch" };
      this.longFired = false;
      if (e.pointerType === "touch") {
        const at = { x: e.clientX, y: e.clientY };
        this.longTimer = setTimeout(() => {
          if (!this.down) return;
          this.longFired = true;
          fire("onContextMenu", at);
        }, LONG_PRESS_MS);
      }
    });
    on("pointermove", (e) => {
      if (this.down) {
        if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > CLICK_MAX_MOVE_PX) {
          cancelLong();
        }
        return;
      }
      if (e.pointerType === "touch" || e.buttons !== 0) return;
      this.hoverPos = { x: e.clientX, y: e.clientY };
      this.hoverDirty = true;
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      cancelLong();
      const d = this.down;
      this.down = null;
      if (!d) return;
      if (this.longFired || e.type === "pointercancel") return;
      const up = sample(e);
      if (
        classifyPointer(d, up, CLICK_MAX_MOVE_PX, d.touch ? TOUCH_TAP_MAX_MS : Infinity) !== "click"
      )
        return;
      const at = { x: e.clientX, y: e.clientY };
      if (d.touch && d.button === 0) {
        const prev = lastTap;
        if (
          prev &&
          up.t - prev.t <= DOUBLE_TAP_MS &&
          Math.hypot(up.x - prev.x, up.y - prev.y) <= DOUBLE_TAP_PX
        ) {
          lastTap = null;
          void host.pickAt(at.x, at.y).then((hit) => {
            if (hit?.kind === "node") host.focusOn(hit.index);
          });
        } else lastTap = up;
      }
      if (d.button === 0) fire("onClick", at);
      else if (d.button === 2) fire("onContextMenu", at);
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("pointerleave", () => this.clearHover());
    on("contextmenu", (e) => e.preventDefault());
    on("dblclick", (e) => {
      void host.pickAt(e.clientX, e.clientY).then((hit) => {
        if (hit?.kind === "node") host.focusOn(hit.index);
      });
    });
  }
}
