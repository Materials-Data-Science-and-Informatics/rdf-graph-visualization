// Card D3 — browser render-check harness for the cosmos.gl adapter (S1-S3).
//
// Bundled for the browser by scripts/cosmos-render-check.mjs (esbuild via
// vite, IIFE) and loaded into a real (headless) page. It installs a fake
// /api/config palette (so S2's per-group colours render), mounts
// createCosmosRenderer into a genuine container div, feeds it the fixture
// graph (node count via window.__COSMOS_OPTIONS__, default 2,000 — S3 scales
// this to 25,000), waits for a real GPU frame, then — when interactions are
// enabled — exercises resetView, a focus fly-to, a node-select dispatch and a
// dark→light→dark theme round trip, sampling the canvas at each stage. The
// result is published on window.__COSMOS_RESULT__ for the driver to assert on.
//
// This is the real-WebGL complement to the Node contract suite: the contract
// test proves the positions/state logic; this harness proves the engine
// actually draws the nodes, styled, and survives basic interaction.

import { loadConfig } from "../src/config";
import { createCosmosRenderer } from "../src/render/cosmos";
import type { CosmosRenderer } from "../src/render/cosmos";
import { makeTwoThousandNodeGraph } from "./fixtures/cosmos-two-thousand";

interface RenderOptions {
  /** Fixture node count (S3 runs 25,000). Default 2,000. */
  nodes?: number;
  /** Run the resetView/focus/select/theme phase after the first frame. */
  interactions?: boolean;
}

interface InteractionResult {
  /** Interaction steps that completed without throwing. */
  performed: string[];
  /** Non-white pixels while the LIGHT theme was active (visibility proof). */
  lightNonWhitePx: number;
  /** Non-black pixels after returning to the dark theme. */
  finalNonBlackPx: number;
  /** Steps that ran but reported ok:false would land here instead. */
  error?: string;
}

interface RenderResult {
  nodes: number;
  links: number;
  headless: boolean;
  theme: string;
  canvas: boolean;
  canvasW: number;
  canvasH: number;
  nonBlackPx: number;
  totalPx: number;
  readyMs: number;
  interactions?: InteractionResult;
  error?: string;
}

const options: RenderOptions =
  (window as unknown as { __COSMOS_OPTIONS__?: RenderOptions }).__COSMOS_OPTIONS__ ?? {};
const NODE_COUNT = options.nodes ?? 2000;
const INTERACTIONS = options.interactions ?? true;

const WIDTH = 800;
const HEIGHT = 600;

const container = document.createElement("div");
container.style.cssText = `position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:#000;`;
document.body.appendChild(container);

function sampleCanvas(theme: "dark" | "light"): {
  canvas: boolean;
  w: number;
  h: number;
  px: number;
} {
  const canvas = container.querySelector("canvas");
  if (!canvas) return { canvas: false, w: 0, h: 0, px: 0 };
  const el = canvas as HTMLCanvasElement;
  const w = el.width;
  const h = el.height;
  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d");
  if (!ctx) return { canvas: true, w, h, px: 0 };
  ctx.drawImage(el, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    // dark theme background #000 → count INK pixels; light theme #fff →
    // count pixels that differ from the paper. >30/<225 keeps antialiasing
    // noise of the flat background out of both counts.
    const drawn =
      theme === "dark"
        ? data[i] > 30 || data[i + 1] > 30 || data[i + 2] > 30
        : data[i] < 225 || data[i + 1] < 225 || data[i + 2] < 225;
    if (drawn) count++;
  }
  return { canvas: true, w, h, px: count };
}

const startedAt = performance.now();

async function run(): Promise<void> {
  // S2: install a palette so getGroupColor() returns distinct per-group
  // colours instead of the empty-registry gray fallback. A stubbed fetch
  // feeds the REAL loadConfig() path from src/config.ts — no test backdoor.
  const palette = [
    { group: "ClassA", type: "Person", color: "#e6194b" },
    { group: "ClassB", type: "Dataset", color: "#3cb44b" },
    { group: "ClassC", type: "Software", color: "#4363d8" },
    { group: "ClassD", type: "Document", color: "#f58231" },
    { group: "ClassE", type: "Institution", color: "#911eb4" },
  ];
  const realFetch = window.fetch;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/config")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            relation_properties: [],
            label_properties: ["label"],
            skip_types: [],
            types: palette,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }
    return realFetch(input, init);
  };
  await loadConfig();
  window.fetch = realFetch;

  const renderer: CosmosRenderer = createCosmosRenderer();
  renderer.mount(container);
  const graph = makeTwoThousandNodeGraph(NODE_COUNT);
  renderer.set(graph);

  function publish(
    sample: { canvas: boolean; w: number; h: number; px: number },
    error?: string,
    interactions?: InteractionResult
  ): void {
    const result: RenderResult = {
      nodes: graph.nodes.length,
      links: graph.links.length,
      headless: renderer.headless,
      theme: renderer.theme,
      canvas: sample.canvas,
      canvasW: sample.w,
      canvasH: sample.h,
      nonBlackPx: sample.px,
      totalPx: sample.w * sample.h,
      readyMs: Math.round(performance.now() - startedAt),
    };
    if (error) result.error = error;
    if (interactions) result.interactions = interactions;
    (window as unknown as { __COSMOS_RESULT__: RenderResult }).__COSMOS_RESULT__ = result;
    document.title = error ? `COSMOS_ERR` : `COSMOS_OK:${result.nodes}`;
  }

  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  // Interaction phase (S3): basic view ops on a live engine. Every step is
  // timed inside try/catch; a throw lands in the published error field.
  async function runInteractions(first: {
    canvas: boolean;
    w: number;
    h: number;
    px: number;
  }): Promise<{
    final: { canvas: boolean; w: number; h: number; px: number };
    res: InteractionResult;
  }> {
    const performed: string[] = [];
    try {
      renderer.resetView();
      performed.push("resetView");
      await wait(600);

      const focusId = graph.nodes[Math.floor(graph.nodes.length / 2)]?.id;
      if (!focusId) throw new Error("fixture produced no nodes");
      let selected: string | null = null;
      const off = renderer.onNodeSelect((nodeId) => {
        selected = nodeId;
      });
      renderer.focus(focusId, 1);
      performed.push("focus");
      await wait(1000); // fly-to transition is 700 ms
      renderer.emitNodeSelect(focusId);
      off();
      if (selected !== focusId) throw new Error(`node-select delivered ${selected}`);
      performed.push("nodeSelect");

      renderer.setTheme("light");
      await wait(500);
      const light = sampleCanvas("light");
      if (!light.canvas || light.px < 500) {
        throw new Error(`light theme canvas blank (${light.px} non-white px)`);
      }
      renderer.setTheme("dark");
      await wait(500);
      performed.push("themeRoundTrip");

      renderer.resetView();
      await wait(600);
      performed.push("resetView-after-focus");

      const final = sampleCanvas("dark");
      if (!final.canvas || final.px < 500) {
        throw new Error(`post-interaction canvas blank (${final.px} non-black px)`);
      }
      return {
        final,
        res: { performed, lightNonWhitePx: light.px, finalNonBlackPx: final.px },
      };
    } catch (err) {
      return {
        final: first,
        res: {
          performed,
          lightNonWhitePx: 0,
          finalNonBlackPx: first.px,
          error: String(err instanceof Error ? err.message : err),
        },
      };
    }
  }

  // Poll until a real frame with drawn points appears (drawn pixels well
  // above the empty-scene noise floor) or time out (~30s for 25k on
  // SwiftShader) and report what we got.
  let tries = 0;
  const maxTries = NODE_COUNT > 5000 ? 300 : 80;
  const timer = window.setInterval(() => {
    tries += 1;
    const sample = sampleCanvas("dark");
    if (sample.canvas && sample.px > 500) {
      window.clearInterval(timer);
      if (!INTERACTIONS) {
        publish(sample);
        return;
      }
      void runInteractions(sample).then(({ final, res }) => {
        publish(final, res.error, res);
      });
    } else if (tries >= maxTries) {
      window.clearInterval(timer);
      publish(
        sample,
        sample.canvas ? "canvas present but drawn pixels below threshold" : "no canvas created"
      );
    }
  }, 100);
}

void run().catch((err) => {
  (window as unknown as { __COSMOS_RESULT__: RenderResult }).__COSMOS_RESULT__ = {
    nodes: 0,
    links: 0,
    headless: true,
    theme: "dark",
    canvas: false,
    canvasW: 0,
    canvasH: 0,
    nonBlackPx: 0,
    totalPx: 0,
    readyMs: Math.round(performance.now() - startedAt),
    error: `harness crashed: ${String(err instanceof Error ? (err.stack ?? err) : err)}`,
  };
});

// Report fatal page errors so the driver can surface them even on a timeout.
// Chrome logs "ResizeObserver loop …" as an error; it is a harmless, well-known
// browser warning (cosmos.gl uses a ResizeObserver), not a render failure.
window.addEventListener("error", (event) => {
  if (/ResizeObserver loop/.test(event.message)) return;
  (window as unknown as { __COSMOS_ERROR__?: string }).__COSMOS_ERROR__ = event.message;
});
