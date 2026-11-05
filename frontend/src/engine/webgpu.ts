/** Thrown by `Engine.create` when the browser has no usable WebGPU adapter. */
export class WebGpuUnavailableError extends Error {
  constructor() {
    super("WebGPU is not available");
    this.name = "WebGpuUnavailableError";
  }
}

export const WEBGPU_NOTICE = "This view needs WebGPU — use a current Chrome, Edge or Safari";

export async function assertWebGpu(): Promise<void> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) throw new WebGpuUnavailableError();
  let adapter: unknown;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    adapter = null;
  }
  if (!adapter) throw new WebGpuUnavailableError();
}

/** Resolve any CSS colour (incl. oklch from the Tailwind theme) to sRGB 0..255 via a 1x1 canvas. */
export function cssToRgb(
  css: string,
  fallback: [number, number, number]
): [number, number, number] {
  try {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch {
    return fallback;
  }
}
