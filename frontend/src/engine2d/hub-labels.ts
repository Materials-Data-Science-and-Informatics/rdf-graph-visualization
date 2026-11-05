/** HTML label overlay for the root and the biggest community hubs (cosmos.gl draws no text). */
import type { Graph } from "@cosmos.gl/graph";
import { shortName, type GraphStore } from "@/lib/graph-store";
import type { Communities } from "./communities";

/** Labelled hubs besides the root. */
export const MAX_HUB_LABELS = 24;
const FRAME_MS = 33;
const CHAR_W = 6.4;
const CHIP_PAD = 10;
const CHIP_H = 18;
const GAP = 3;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Indices of the boxes to show, in priority order: on screen and not overlapping an earlier shown one. */
export function pickVisible(boxes: (Box | null)[], width: number, height: number): number[] {
  const placed: Box[] = [];
  const shown: number[] = [];
  boxes.forEach((b, i) => {
    if (!b || b.x < 0 || b.y < 0 || b.x + b.w > width || b.y + b.h > height) return;
    if (placed.some((p) => overlaps(p, b))) return;
    placed.push(b);
    shown.push(i);
  });
  return shown;
}

/** Root first, then the largest communities' hubs (hubs are ordered largest first). */
export function labelCandidates(communities: Communities | null, max = MAX_HUB_LABELS): number[] {
  const out = [0];
  if (communities) {
    for (const h of communities.hubs) {
      if (out.length > max) break;
      if (h !== 0) out.push(h);
    }
  }
  return out;
}

export class HubLabels {
  private readonly layer: HTMLDivElement;
  private readonly chips = new Map<number, HTMLDivElement>();
  private candidates: number[] = [];
  private store: GraphStore | null = null;
  private raf = 0;
  private last = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly graph: Graph
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "pointer-events-none absolute inset-0 overflow-hidden";
    this.layer.dataset.slot = "hub-labels";
    host.appendChild(this.layer);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Tracks the root and the top hubs; call when the communities or the generation change. */
  setCandidates(store: GraphStore, communities: Communities | null, nodes: number): void {
    this.store = store;
    this.candidates = labelCandidates(communities).filter((i) => i < nodes);
    this.graph.trackPointPositionsByIndices(this.candidates);
    for (const [i, el] of this.chips) {
      if (!this.candidates.includes(i)) {
        el.remove();
        this.chips.delete(i);
      }
    }
  }

  /** Drops all labels and tracking (new generation, dim switch, empty window). */
  clear(): void {
    this.candidates = [];
    this.graph.trackPointPositionsByIndices([]);
    for (const el of this.chips.values()) el.remove();
    this.chips.clear();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.layer.remove();
    this.chips.clear();
  }

  private chip(i: number): HTMLDivElement {
    let el = this.chips.get(i);
    if (!el) {
      el = document.createElement("div");
      el.className =
        "bg-background/80 text-foreground absolute top-0 left-0 hidden max-w-48 truncate rounded px-1 text-[11px] leading-[18px] shadow-sm";
      this.layer.appendChild(el);
      this.chips.set(i, el);
    }
    return el;
  }

  private readonly frame = (t: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (t - this.last < FRAME_MS || !this.store || this.candidates.length === 0) return;
    this.last = t;
    this.update(this.store);
  };

  /** Per frame: <= 25 tracked positions + text/box math, no DOM reads except the host size. */
  private update(store: GraphStore): void {
    const pos = this.graph.getTrackedPointPositionsMap({ nonBlocking: true });
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const texts: string[] = [];
    const boxes = this.candidates.map((i, k): Box | null => {
      const p = pos.get(i);
      if (!p) return null;
      const text = store.labels[i] ?? shortName(store.nodeIds[i] ?? "");
      texts[k] = text;
      const [sx, sy] = this.graph.spaceToScreenPosition(p);
      const r = Math.min(
        40,
        this.graph.spaceToScreenRadius(this.graph.getPointRadiusByIndex(i) ?? 2)
      );
      const bw = Math.min(192, text.length * CHAR_W + CHIP_PAD);
      return { x: sx - bw / 2, y: sy + r + GAP, w: bw, h: CHIP_H };
    });
    const shown = new Set(pickVisible(boxes, w, h));
    this.candidates.forEach((i, k) => {
      const el = this.chip(i);
      const b = boxes[k];
      if (!b || !shown.has(k)) {
        el.classList.add("hidden");
        return;
      }
      if (el.textContent !== texts[k]) el.textContent = texts[k];
      el.style.transform = `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`;
      el.classList.remove("hidden");
    });
  }
}
