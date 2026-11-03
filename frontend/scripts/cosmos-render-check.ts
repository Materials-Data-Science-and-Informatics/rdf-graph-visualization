// Card D3 — browser render-check harness for the cosmos.gl adapter (S1).
//
// Bundled for the browser by scripts/cosmos-render-check.mjs (esbuild via
// vite, IIFE) and loaded into a real (headless) page. It mounts
// createCosmosRenderer into a genuine container div, feeds it the 2,000-node
// fixture, waits for a real GPU frame, then samples the canvas to confirm it
// is non-blank and publishes the result on window.__COSMOS_RESULT__ for the
// driver to assert on.
//
// This is the real-WebGL complement to the Node contract suite: the contract
// test proves the positions/state logic; this harness proves the engine
// actually draws the 2k nodes.

import { createCosmosRenderer } from "../src/render/cosmos";
import type { CosmosRenderer } from "../src/render/cosmos";
import { makeTwoThousandNodeGraph } from "./fixtures/cosmos-two-thousand";

interface RenderResult {
  nodes: number;
  links: number;
  headless: boolean;
  canvas: boolean;
  canvasW: number;
  canvasH: number;
  nonBlackPx: number;
  totalPx: number;
  readyMs: number;
  error?: string;
}

const WIDTH = 800;
const HEIGHT = 600;

const container = document.createElement("div");
container.style.cssText = `position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:#000;`;
document.body.appendChild(container);

const startedAt = performance.now();
const renderer: CosmosRenderer = createCosmosRenderer();
renderer.mount(container);
const graph = makeTwoThousandNodeGraph(2000);
renderer.set(graph);

function sampleCanvas(): { canvas: boolean; w: number; h: number; nonBlack: number } {
  const canvas = container.querySelector("canvas");
  if (!canvas) return { canvas: false, w: 0, h: 0, nonBlack: 0 };
  const el = canvas as HTMLCanvasElement;
  const w = el.width;
  const h = el.height;
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d");
  if (!ctx) return { canvas: true, w, h, nonBlack: 0 };
  ctx.drawImage(el, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30) nonBlack++;
  }
  return { canvas: true, w, h, nonBlack };
}

function publish(
  sample: { canvas: boolean; w: number; h: number; nonBlack: number },
  error?: string
): void {
  const result: RenderResult = {
    nodes: graph.nodes.length,
    links: graph.links.length,
    headless: renderer.headless,
    canvas: sample.canvas,
    canvasW: sample.w,
    canvasH: sample.h,
    nonBlackPx: sample.nonBlack,
    totalPx: sample.w * sample.h,
    readyMs: Math.round(performance.now() - startedAt),
  };
  if (error) result.error = error;
  (window as unknown as { __COSMOS_RESULT__: RenderResult }).__COSMOS_RESULT__ = result;
  document.title = error ? `COSMOS_ERR` : `COSMOS_OK:${result.nodes}`;
}

// Poll until a real frame with drawn points appears (non-black pixels well
// above the empty-scene noise floor) or time out (~8s) and report what we got.
let tries = 0;
const timer = window.setInterval(() => {
  tries += 1;
  const sample = sampleCanvas();
  if (sample.canvas && sample.nonBlack > 500) {
    window.clearInterval(timer);
    publish(sample);
  } else if (tries >= 80) {
    window.clearInterval(timer);
    publish(
      sample,
      sample.canvas ? "canvas present but non-black pixels below threshold" : "no canvas created"
    );
  }
}, 100);

// Report fatal page errors so the driver can surface them even on a timeout.
// Chrome logs "ResizeObserver loop …" as an error; it is a harmless, well-known
// browser warning (cosmos.gl uses a ResizeObserver), not a render failure.
window.addEventListener("error", (event) => {
  if (/ResizeObserver loop/.test(event.message)) return;
  (window as unknown as { __COSMOS_ERROR__?: string }).__COSMOS_ERROR__ = event.message;
});
