import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { EngineHandlers } from "@/engine/engine";
import { NARROW } from "@/lib/sidebar-settings";

/** One global Escape: details card first, then the narrow-screen sidebar overlay. */
export function useEscapeClose(
  hasSel: boolean,
  sidebarOpen: boolean,
  closeDetails: () => void,
  closeSidebar: () => void
): void {
  const latest = useRef({ hasSel, sidebarOpen, closeDetails, closeSidebar });
  useEffect(() => {
    latest.current = { hasSel, sidebarOpen, closeDetails, closeSidebar };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const l = latest.current;
      if (l.hasSel) l.closeDetails();
      else if (l.sidebarOpen && window.matchMedia(NARROW).matches) l.closeSidebar();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Hover card follows the pointer (direct style writes, no re-render per move). */
export function useTipPlacement(
  tipRef: RefObject<HTMLDivElement | null>,
  wrapRef: RefObject<HTMLDivElement | null>,
  pointerRef: RefObject<{ x: number; y: number }>,
  hover: unknown
): () => void {
  const placeTip = useCallback(() => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const { x: px, y: py } = pointerRef.current;
    let x = px - r.left + 14;
    let y = py - r.top + 14;
    if (x + tip.offsetWidth > r.width - 4) x = px - r.left - 14 - tip.offsetWidth;
    if (y + tip.offsetHeight > r.height - 4) y = py - r.top - 14 - tip.offsetHeight;
    tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }, [tipRef, wrapRef, pointerRef]);
  useLayoutEffect(placeTip, [hover, placeTip]);
  return placeTip;
}

/** 3D engine pointer handlers: hover reports out, click selects, right-click re-roots. */
export function engineHandlers(
  ref: RefObject<{
    selectNode(i: number): void;
    clearSelection(): void;
    makeRoot(i: number): void;
  }>,
  onHover: EngineHandlers["onHover"]
): EngineHandlers {
  return {
    onHover,
    onClick: (hit) => {
      if (hit?.kind === "node") ref.current.selectNode(hit.index);
      else ref.current.clearSelection();
    },
    onContextMenu: (hit) => {
      if (hit?.kind === "node") ref.current.makeRoot(hit.index);
    },
  };
}
