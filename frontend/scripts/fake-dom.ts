// Minimal fake DOM for running the sigma 2D adapter in Node (D2 contract
// test).
//
// sigma.js renders nodes/edges through WebGL programs and labels through 2D
// canvas layers. This provides just enough DOM for the adapter's real scene
// construction to run to completion headless:
//
//   - `HTMLElement` identity (sigma checks `container instanceof HTMLElement`);
//   - container/child elements with style, offsetWidth/Height,
//     getBoundingClientRect(), and a working addEventListener/dispatchEvent;
//   - canvas 2D context: a no-op proxy that RECORDS fillText calls (the
//     label-LOD checks count rendered labels);
//   - WebGL context: a no-op proxy returning spec-shaped values (compile/
//     link status true, locations 0, objects opaque ids) and an armable
//     readPixels, so sigma's picking (item index encoded in the pixel RGB:
//     index = b + (g<<8) + (r<<16)) can be made to decode a specific node —
//     that is how the contract test simulates a user click.
//
// Nothing here validates pixels: the point is to exercise sigma's real
// JS-side scene construction, camera, and event pipeline against the
// adapter, not to rasterise.

// ------------------------------------------------------------------ element

export class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  offsetWidth: number;
  offsetHeight: number;
  parent: FakeElement | null = null;

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(tagName = "DIV", width = 800, height = 600) {
    this.tagName = tagName.toUpperCase();
    this.offsetWidth = width;
    this.offsetHeight = height;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  addEventListener(type: string, fn: (...args: unknown[]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (...args: unknown[]) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(event: { type: string; [k: string]: unknown }): boolean {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
    return true;
  }

  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
    x: number;
    y: number;
  } {
    return {
      left: 0,
      top: 0,
      right: this.offsetWidth,
      bottom: this.offsetHeight,
      width: this.offsetWidth,
      height: this.offsetHeight,
      x: 0,
      y: 0,
    };
  }
}

// ------------------------------------------------------------------- canvas

const noop = () => undefined;

/** 2D context: no-op proxy; records fillText (label) calls. */
export function makeFake2DContext(canvas: FakeCanvas): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {
    fillText: (text: string) => {
      fillTextLog.push(String(text));
    },
    measureText: (text: string) => ({ width: String(text).length * 6 }),
  };
  return new Proxy(state, {
    get(target, prop) {
      if (prop === "canvas") return canvas;
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^[a-z]/.test(prop)) return noop;
      return undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

export interface FakeGLCounts {
  drawCalls: number;
  bufferData: number;
}

let armedPickingPixel: [number, number, number, number] | null = null;

const constants = new Map<string, number>();
const constantHash = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return 1000 + (Math.abs(h) % 900000);
};

/** WebGL context: no-op proxy returning spec-shaped canned values. */
export function makeFakeGL(canvas: FakeCanvas): WebGLRenderingContext {
  let objId = 0;

  const target: Record<string | symbol, unknown> = {
    canvas,
  };
  const targetGet = (prop: string): unknown => {
    switch (prop) {
      case "drawingBufferWidth":
        return canvas.width;
      case "drawingBufferHeight":
        return canvas.height;
      case "createShader":
      case "createProgram":
      case "createBuffer":
      case "createTexture":
      case "createFramebuffer":
        return () => ++objId;
      case "getShaderParameter":
      case "getProgramParameter":
        return () => true;
      case "getAttribLocation":
        return () => 0;
      case "getUniformLocation":
        return () => ({ __loc: ++objId });
      case "getError":
        return () => 0;
      case "checkFramebufferStatus":
        return () => 1;
      case "getParameter":
        return () => 4096;
      case "drawElements":
      case "drawArrays":
      case "drawArraysInstanced":
        return () => {
          glCounts.drawCalls += 1;
        };
      case "bufferData":
        return () => {
          glCounts.bufferData += 1;
        };
      case "readPixels":
        return (
          _x: number,
          _y: number,
          _w: number,
          _h: number,
          _format: number,
          _type: number,
          pixel: Uint8Array
        ) => {
          for (let i = 0; i < pixel.length && i < 4; i++) {
            pixel[i] = armedPickingPixel ? (armedPickingPixel[i] ?? 0) : 0;
          }
        };
    }
    if (prop in target) return target[prop];
    if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
      let c = constants.get(prop);
      if (c === undefined) {
        c = constantHash(prop);
        constants.set(prop, c);
      }
      return c;
    }
    if (/^[a-z]/.test(prop)) return noop;
    return undefined;
  };

  return new Proxy(target, {
    get(_t, prop) {
      return typeof prop === "string" ? targetGet(prop) : undefined;
    },
    set(_t, prop, value) {
      if (typeof prop === "string") target[prop] = value;
      return true;
    },
  }) as unknown as WebGLRenderingContext;
}

export class FakeCanvas extends FakeElement {
  width = 800;
  height = 600;
  private ctx2d: CanvasRenderingContext2D;
  private gl: WebGLRenderingContext;

  constructor() {
    super("CANVAS");
    this.ctx2d = makeFake2DContext(this);
    this.gl = makeFakeGL(this);
  }

  getContext(kind: string): unknown {
    if (kind === "2d") return this.ctx2d;
    if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return this.gl;
    return null;
  }
}

// ------------------------------------------------------------- raf plumbing

const rafQueue = new Map<number, (time: number) => void>();
let rafId = 0;

function requestAnimationFrame(cb: (time: number) => void): number {
  const id = ++rafId;
  rafQueue.set(id, cb);
  return id;
}

function cancelAnimationFrame(id: number): void {
  rafQueue.delete(id);
}

/** Run queued animation frames (a few passes for re-scheduling). */
export function flushRaf(maxPasses = 8): void {
  for (let pass = 0; pass < maxPasses && rafQueue.size > 0; pass++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [id, cb] of due) {
      rafQueue.delete(id);
      cb(16 * (pass + 1));
    }
  }
}

// -------------------------------------------------------------------- state

export const fillTextLog: string[] = [];
export const glCounts: FakeGLCounts = { drawCalls: 0, bufferData: 0 };

export interface FakeDomHandle {
  reset(): void;
  /** Make sigma's picking decode this item index (r/g/b per sigma's scheme). */
  armPickingIndex(index: number): void;
  clearArmedPixel(): void;
  /** The canvas sigma's mouse captor binds to (the one with touchAction none). */
  findMouseCanvas(container: FakeElement): FakeCanvas;
  dispatchClick(element: FakeElement, x: number, y: number): void;
}

export function installFakeDom(): FakeDomHandle {
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = FakeElement;
  g.requestAnimationFrame = requestAnimationFrame;
  g.cancelAnimationFrame = cancelAnimationFrame;
  // sigma's bundle reads these constants at module level / at runtime, and
  // checks `x instanceof WebGL2RenderingContext` / `instanceof
  // HTMLCanvasElement` — so the globals must be classes (with the constants
  // as statics) whose hasInstance accepts the fake objects.
  const webgl2Constants = {
    BOOL: 0x8b34,
    BYTE: 0x1400,
    UNSIGNED_BYTE: 0x1401,
    SHORT: 0x1402,
    UNSIGNED_SHORT: 0x1403,
    INT: 0x1404,
    UNSIGNED_INT: 0x1405,
    FLOAT: 0x1406,
    RGBA: 0x1908,
  };
  class FakeWebGL2RenderingContext {
    static [Symbol.hasInstance](): boolean {
      return true;
    }
  }
  Object.assign(FakeWebGL2RenderingContext, webgl2Constants);
  class FakeWebGLRenderingContext extends FakeWebGL2RenderingContext {}
  Object.assign(FakeWebGLRenderingContext, {
    ...webgl2Constants,
    COLOR_BUFFER_BIT: 0x4000,
    FRAMEBUFFER: 0x8d40,
  });
  class FakeHTMLCanvasElement {
    static [Symbol.hasInstance](): boolean {
      return true;
    }
  }
  if (typeof g.WebGL2RenderingContext === "undefined") {
    g.WebGL2RenderingContext = FakeWebGL2RenderingContext;
  }
  if (typeof g.WebGLRenderingContext === "undefined") {
    g.WebGLRenderingContext = FakeWebGLRenderingContext;
  }
  if (typeof g.HTMLCanvasElement === "undefined") {
    g.HTMLCanvasElement = FakeHTMLCanvasElement;
  }
  g.window = {
    devicePixelRatio: 1,
    location: { search: "", href: "" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame,
    cancelAnimationFrame,
  };
  g.document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tag: string) => (tag === "canvas" ? new FakeCanvas() : new FakeElement(tag)),
  };

  const handle: FakeDomHandle = {
    reset(): void {
      fillTextLog.length = 0;
      glCounts.drawCalls = 0;
      glCounts.bufferData = 0;
      rafQueue.clear();
      armedPickingPixel = null;
    },
    armPickingIndex(index: number): void {
      // sigma encodes indexToColor as r=(i>>16)&0xff, g=(i>>8)&0xff, b=i&0xff,
      // and decodes readPixels as index = b + (g<<8) + (r<<16).
      armedPickingPixel = [
        (index >> 16) & 0xff, // r
        (index >> 8) & 0xff, // g
        index & 0xff, // b
        255, // a
      ];
    },
    clearArmedPixel(): void {
      armedPickingPixel = null;
    },
    findMouseCanvas(container: FakeElement): FakeCanvas {
      const found = container.children.find(
        (c): c is FakeCanvas => c instanceof FakeCanvas && c.style.touchAction === "none"
      );
      if (!found) throw new Error("fake-dom: mouse canvas not found in container");
      return found;
    },
    dispatchClick(element: FakeElement, x: number, y: number): void {
      element.dispatchEvent({
        type: "click",
        clientX: x,
        clientY: y,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    },
  };
  return handle;
}

// Auto-install on import: the sigma package references WebGL2RenderingContext
// at MODULE level, so the globals must exist before the sigma bundle
// evaluates — importing this file (before ../src/render) is the hook.
export const fakeDom: FakeDomHandle = installFakeDom();
