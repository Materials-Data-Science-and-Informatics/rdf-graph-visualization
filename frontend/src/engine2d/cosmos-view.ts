/** 2D graph view on cosmos.gl: renders the GraphStore window and keeps the layout running while it grows. */
import { Graph } from "@cosmos.gl/graph";
import { UNTYPED_ALPHA } from "@/engine/curve";
import { appendWindowEdges } from "@/engine/layout-utils";
import { cssToRgb } from "@/engine/webgpu";
import type { GraphStore } from "@/lib/graph-store";
import { placeNodes } from "./placement";

const SPACE_SIZE = 4096;
const CENTER = SPACE_SIZE / 2;
const NO_GROUP_COLOR = "#8a8f98";
const ALPHA_FRESH = 1;
const ALPHA_GROWTH = 0.35;
const FIT_MS = 400;
const FIT_EVERY_MS = 1000;

export interface CosmosHandlers {
  onPointClick: (index: number) => void;
  onPointContextMenu: (index: number) => void;
  onBackgroundClick: () => void;
}

export interface CosmosOptions {
  curved: boolean;
  arrows: boolean;
  edgeOpacity: number;
}

type Rgba = [number, number, number, number];

export class CosmosView {
  private readonly graph: Graph;
  private readonly themeObs: MutationObserver;
  private readonly colorCache = new Map<string, [number, number, number]>();
  private palette: ReadonlyMap<string, string> = new Map();
  private paletteVersion = 0;
  private generation = -1;
  private nodes = 0;
  private edges = 0;
  private limit = 0;
  private seenPalette = -1;
  private dark = true;
  private autoFit = true;
  private lastFit = 0;
  private ticks = 0;
  private fpsAt = performance.now();
  fps = 0;

  constructor(
    private readonly host: HTMLDivElement,
    handlers: CosmosHandlers,
    opts: CosmosOptions
  ) {
    this.graph = new Graph(host, {
      spaceSize: SPACE_SIZE,
      backgroundColor: this.readBackground(),
      pointDefaultSize: 4,
      scalePointsOnZoom: true,
      linkDefaultWidth: 1,
      linkOpacity: this.linkOpacity(opts.edgeOpacity),
      curvedLinks: opts.curved,
      linkDefaultArrows: opts.arrows,
      renderHoveredPointRing: true,
      focusedPointRingColor: "#ffffff",
      enableDrag: true,
      enableRightClickRepulsion: false,
      fitViewOnInit: false,
      transitionDuration: 0, // a position transition would pause the running simulation
      // weak gravity: a strong pull to the centre squeezed each hub's leaves into a wedge
      // on the centre side; stronger repulsion fans them out all around the hub
      simulationDecay: 1000,
      simulationGravity: 0.05,
      simulationRepulsion: 2,
      simulationLinkSpring: 1,
      simulationLinkDistance: 15,
      onPointClick: (i) => handlers.onPointClick(i),
      onPointContextMenu: (i, _pos, e) => {
        e.preventDefault();
        handlers.onPointContextMenu(i);
      },
      onBackgroundClick: () => handlers.onBackgroundClick(),
      onBackgroundContextMenu: (e) => e.preventDefault(),
      onZoomStart: (_e, userDriven) => {
        if (userDriven) this.autoFit = false;
      },
      onSimulationTick: () => {
        this.ticks++;
      },
      onSimulationEnd: () => {
        if (this.autoFit) this.graph.fitView(FIT_MS);
      },
    });
    this.themeObs = new MutationObserver(() =>
      this.graph.setConfigPartial({ backgroundColor: this.readBackground() })
    );
    this.themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  get settling(): boolean {
    return this.graph.isSimulationRunning;
  }

  setOptions(o: CosmosOptions): void {
    this.graph.setConfigPartial({
      curvedLinks: o.curved,
      linkDefaultArrows: o.arrows,
      linkOpacity: this.linkOpacity(o.edgeOpacity),
    });
  }

  setPalette(palette: ReadonlyMap<string, string>): void {
    this.palette = palette;
    this.paletteVersion++;
  }

  setSelected(index: number | null): void {
    this.graph.setConfigPartial({ focusedPointIndex: index ?? undefined });
  }

  focusOn(index: number): void {
    this.graph.zoomToPointByIndex(index, 600, 6, true);
    this.autoFit = false;
  }

  resetView(): void {
    this.autoFit = true;
    this.graph.fitView(FIT_MS);
  }

  /** Cheap change check, meant to be called on a timer; pushes data only when the window changed. */
  poll(store: GraphStore, nodeLimit: number): void {
    const n = Math.min(store.nodeCount, nodeLimit);
    const fresh = store.generation !== this.generation;
    if (
      !fresh &&
      n === this.nodes &&
      store.edgeCount === this.edges &&
      nodeLimit === this.limit &&
      this.seenPalette === this.paletteVersion
    ) {
      this.fitWhileRunning();
      return;
    }
    this.push(store, n, nodeLimit, fresh);
  }

  destroy(): void {
    this.themeObs.disconnect();
    this.graph.destroy();
  }

  /** Measured simulation ticks per second since the last call (0 while idle). */
  sampleFps(): void {
    const now = performance.now();
    this.fps = Math.round((this.ticks * 1000) / (now - this.fpsAt));
    this.ticks = 0;
    this.fpsAt = now;
  }

  private push(store: GraphStore, n: number, nodeLimit: number, fresh: boolean): void {
    const g = this.graph;
    const prevCount = fresh ? 0 : Math.min(this.nodes, n);
    const prev = prevCount > 0 ? g.getPointPositionsArray() : new Float32Array(0);
    const pos = placeNodes(prev, prevCount, n, store.edges, store.edgeCount, CENTER);
    const win = new Uint32Array(store.edgeCount * 2);
    const m = appendWindowEdges(store.edges, 0, store.edgeCount, n, win, 0);
    const links = new Float32Array(m * 2);
    const linkColors = new Float32Array(m * 4);
    let k = 0;
    for (let e = 0; e < store.edgeCount; e++) {
      if (store.edges[2 * e] >= n || store.edges[2 * e + 1] >= n) continue;
      const iri = store.predicates[store.edgePredicate[e]];
      const c = this.rgb(
        (iri !== undefined ? this.palette.get(iri) : undefined) ?? this.linkGrey()
      );
      linkColors.set([c[0], c[1], c[2], 1], 4 * k++);
    }
    for (let i = 0; i < 2 * m; i++) links[i] = win[i];
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const grp = store.groups[i];
      const typed = grp >= 0 && grp < store.groupColors.length;
      const c = this.rgb(typed ? store.groupColors[grp] : NO_GROUP_COLOR);
      colors.set([c[0], c[1], c[2], typed ? 1 : UNTYPED_ALPHA], 4 * i);
    }
    g.setPointPositions(pos, true);
    g.setLinks(links);
    g.setPointColors(colors);
    g.setLinkColors(linkColors);
    if (fresh) {
      this.autoFit = true;
      g.setConfigPartial({ focusedPointIndex: undefined });
    }
    g.render(fresh ? ALPHA_FRESH : undefined, 0);
    g.start(fresh || prevCount === 0 ? ALPHA_FRESH : ALPHA_GROWTH);
    this.generation = store.generation;
    this.nodes = n;
    this.edges = store.edgeCount;
    this.limit = nodeLimit;
    this.seenPalette = this.paletteVersion;
    this.lastFit = 0;
  }

  private fitWhileRunning(): void {
    const now = performance.now();
    if (this.autoFit && this.nodes > 0 && this.settling && now - this.lastFit > FIT_EVERY_MS) {
      this.lastFit = now;
      this.graph.fitView(FIT_MS);
    }
  }

  private rgb(css: string): [number, number, number] {
    let c = this.colorCache.get(css);
    if (!c) {
      const [r, g, b] = cssToRgb(css, [138, 143, 152]);
      c = [r / 255, g / 255, b / 255];
      this.colorCache.set(css, c);
    }
    return c;
  }

  private linkGrey(): string {
    return this.dark ? "#9ca3af" : "#6b7280";
  }

  private linkOpacity(edgeOpacity: number): number {
    return Math.min(1, 0.6 * edgeOpacity);
  }

  /** Background follows the app theme (`--background`, possibly oklch -> resolved via canvas). */
  private readBackground(): Rgba {
    const css = getComputedStyle(this.host).getPropertyValue("--background").trim();
    const [r, g, b] = cssToRgb(css || "#0a0a0a", [10, 10, 10]);
    this.dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    return [r / 255, g / 255, b / 255, 1];
  }
}
