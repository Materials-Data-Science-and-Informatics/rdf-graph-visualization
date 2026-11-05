import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Maximize, Minimize, PanelLeftOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchNode, type GraphGroupConfig, type NodeInfo } from "@/lib/api";
import type { Engine } from "@/engine/engine";
import { NODE_LIMIT_DEFAULT, NODE_LIMIT_MAX, NODE_LIMIT_MIN } from "@/engine/layout-utils";
import { WEBGPU_NOTICE, WebGpuUnavailableError } from "@/engine/webgpu";
import { DEFAULT_ROOT_IRI } from "@/lib/config";
import { statusText, useGraphStream } from "@/lib/use-graph-stream";
import { shortName } from "@/lib/graph-store";
import {
  FANOUT_KEY,
  clampDepth,
  clampFanout,
  depthToMaxHops,
  fanoutParam,
  loadFanout,
  groupCounts,
  ARROWS_KEY,
  CURVED_KEY,
  DIM_KEY,
  EDGE_OPACITY_KEY,
  ROOT_KEY,
  loadArrows,
  loadCurved,
  loadDepth,
  loadDim,
  loadEdgeOpacity,
  loadRoot,
  saveBool,
  saveDepth,
  savePref,
} from "@/lib/sidebar-settings";
import type { PickHit } from "@/engine/picking";
import { relationCounts, relationPalette } from "@/lib/relation-colors";
import Sidebar from "./Sidebar";
import NodeDetails, { type SelectedView } from "./NodeDetails";
import GraphTooltip from "./GraphTooltip";
import type { GraphControl } from "./SearchBox";

const PENDING_SELECT_MS = 20000;

const NARROW = "(max-width: 767px)";
const DEPTH_DEBOUNCE_MS = 500;
const NO_GROUP_COLOR = "#8a8f98";
const UNCLASSIFIED = "Unclassified";

const NODE_LIMIT_KEY = "hkg-node-limit";
const loadNodeLimit = (): number => {
  try {
    const v = Number(localStorage.getItem(NODE_LIMIT_KEY));
    return v >= NODE_LIMIT_MIN && v <= NODE_LIMIT_MAX ? v : NODE_LIMIT_DEFAULT;
  } catch {
    return NODE_LIMIT_DEFAULT;
  }
};

/** Canvas host: the GPU engine mounts into the `canvas-host` div and pulls deltas from the stream's store. */
export default function GraphView({
  groups,
  relations,
  control,
}: {
  groups: GraphGroupConfig[];
  relations: string[];
  control: React.RefObject<GraphControl | null>;
}) {
  const { store, status, start } = useGraphStream(groups);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [fps, setFps] = useState(0);
  const [settling, setSettling] = useState(false);
  const [nodeLimit, setNodeLimit] = useState(loadNodeLimit);
  const nodeLimitRef = useRef(nodeLimit);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [isFullscreen, setFullscreen] = useState(false);

  const [depth, setDepth] = useState(loadDepth);
  const [appliedDepth, setAppliedDepth] = useState(depth);
  const [fanout, setFanout] = useState(loadFanout);
  const [appliedFanout, setAppliedFanout] = useState(fanout);
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const [rootIri, setRootIri] = useState(() => loadRoot(DEFAULT_ROOT_IRI));
  const [selected, setSelected] = useState<SelectedView | null>(null);
  const selectAbort = useRef<AbortController | null>(null);
  const [hover, setHover] = useState<PickHit | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [rootInfo, setRootInfo] = useState<NodeInfo | null>(null);
  const [shown, setShown] = useState(0);
  const [counts, setCounts] = useState<number[]>([]);
  const [relCounts, setRelCounts] = useState<Map<string, number>>(new Map());
  const palette = useMemo(() => relationPalette(relations), [relations]);
  const paletteRef = useRef(palette);
  // eslint-disable-next-line react-hooks/refs -- latest-value ref read by engine callbacks
  paletteRef.current = palette;
  const [dim, setDimState] = useState<2 | 3>(loadDim);
  const [edgeOpacity, setEdgeOpacity] = useState(loadEdgeOpacity);
  const [arrows, setArrows] = useState(loadArrows);
  const [curved, setCurved] = useState(loadCurved);
  const settingsRef = useRef({ dim, edgeOpacity, arrows, curved });
  // eslint-disable-next-line react-hooks/refs -- latest-value ref read by engine callbacks
  settingsRef.current = { dim, edgeOpacity, arrows, curved };

  // Depth changes restart the stream; omitted max_hops (default 6) keeps the cached snapshot key.
  useEffect(() => {
    start(rootIri, {
      maxHops: depthToMaxHops(appliedDepth),
      maxFanout: fanoutParam(appliedFanout),
    });
  }, [start, appliedDepth, appliedFanout, rootIri]);

  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedDepth(depth);
      setAppliedFanout(fanout);
    }, DEPTH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [depth, fanout]);

  const onFanout = useCallback((n: number) => {
    const v = clampFanout(n);
    setFanout(v);
    savePref(FANOUT_KEY, String(v));
  }, []);

  const onDepth = useCallback((d: number) => {
    const v = clampDepth(d);
    setDepth(v);
    saveDepth(v);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchNode(rootIri, ctrl.signal)
      .then(setRootInfo)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [rootIri]);

  const clearSelection = useCallback(() => {
    selectAbort.current?.abort();
    selectAbort.current = null;
    setSelected(null);
    engineRef.current?.setSelected(null);
  }, []);

  const selectNode = useCallback(
    (index: number) => {
      const iri = store.nodeIds[index];
      if (iri === undefined) return;
      selectAbort.current?.abort();
      const ctrl = new AbortController();
      selectAbort.current = ctrl;
      engineRef.current?.setSelected(index);
      setSelected({ iri, status: "loading" });
      fetchNode(iri, ctrl.signal)
        .then((info) => {
          if (ctrl.signal.aborted) return;
          setSelected({ iri, status: info ? "ok" : "none", info: info ?? undefined });
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setSelected({
            iri,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [store]
  );

  // Select-after-reroot request: resolved only once the store was reset (generation moved on).
  const pendingSelect = useRef<{ iri: string; gen: number; until: number } | null>(null);

  /** Make an IRI the new root; positions of known nodes carry over. */
  const makeRootIri = useCallback(
    (iri: string) => {
      pendingSelect.current = null;
      if (iri === rootIri) return;
      engineRef.current?.captureForReroot();
      clearSelection();
      setHover(null);
      setRootInfo(null);
      setRootIri(iri);
      savePref(ROOT_KEY, iri);
    },
    [clearSelection, rootIri]
  );
  /** Right click: the node becomes the new root. */
  const makeRoot = useCallback(
    (index: number) => {
      const iri = store.nodeIds[index];
      if (iri !== undefined) makeRootIri(iri);
    },
    [store, makeRootIri]
  );

  // Search box API: select once the node (new root) shows up in the visible window.
  const inWindow = useCallback(
    (iri: string) => {
      const i = store.indexOf(iri);
      return i >= 0 && i < nodeLimitRef.current ? i : -1;
    },
    [store]
  );
  const focusSelect = useCallback(
    (i: number) => {
      selectNode(i);
      engineRef.current?.focusOn(i);
    },
    [selectNode]
  );
  const requestRoot = useCallback(
    (iri: string) => {
      makeRootIri(iri);
      pendingSelect.current = {
        iri,
        gen: store.generation,
        until: Date.now() + PENDING_SELECT_MS,
      };
    },
    [makeRootIri, store]
  );
  // eslint-disable-next-line react-hooks/immutability -- control is a stable imperative handle ref owned by the parent
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- same handle ref as above
    control.current = {
      has: (iri) => inWindow(iri) >= 0,
      open: (iri) => {
        const i = inWindow(iri);
        if (i >= 0) return focusSelect(i);
        requestRoot(iri);
      },
      makeRoot: (iri) => {
        if (iri === rootIri) {
          pendingSelect.current = null;
          const i = inWindow(iri);
          if (i >= 0) focusSelect(i);
        } else requestRoot(iri);
      },
    };
    return () => {
      control.current = null;
    };
  }, [control, inWindow, focusSelect, requestRoot, rootIri]);
  const closeDetails = useCallback(() => {
    clearSelection();
    wrapRef.current?.focus();
  }, [clearSelection]);
  const escRef = useRef({ hasSel: false, sidebarOpen: false });
  // eslint-disable-next-line react-hooks/refs -- latest-value ref read by the Escape handler
  escRef.current = { hasSel: selected !== null, sidebarOpen };
  // one global Escape: details card first, then the narrow-screen sidebar overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      if (escRef.current.hasSel) closeDetails();
      else if (escRef.current.sidebarOpen && window.matchMedia(NARROW).matches)
        setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeDetails]);
  const handlersRef = useRef({ selectNode, clearSelection, makeRoot, focusSelect });
  // eslint-disable-next-line react-hooks/refs -- latest-value ref read by engine callbacks
  handlersRef.current = { selectNode, clearSelection, makeRoot, focusSelect };

  // hover card follows the pointer (direct style writes, no re-render per move)
  const placeTip = useCallback(() => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    const r = wrap.getBoundingClientRect();
    let x = pointerRef.current.x - r.left + 14;
    let y = pointerRef.current.y - r.top + 14;
    if (x + tip.offsetWidth > r.width - 4) x = pointerRef.current.x - r.left - 14 - tip.offsetWidth;
    if (y + tip.offsetHeight > r.height - 4)
      y = pointerRef.current.y - r.top - 14 - tip.offsetHeight;
    tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }, []);
  useLayoutEffect(placeTip, [hover, placeTip]);

  const onDim = useCallback((d: 2 | 3) => {
    setDimState(d);
    savePref(DIM_KEY, String(d));
    engineRef.current?.setDim(d);
  }, []);
  const onEdgeOpacity = useCallback((v: number) => {
    setEdgeOpacity(v);
    savePref(EDGE_OPACITY_KEY, String(v));
    engineRef.current?.setEdgeOpacityScale(v);
  }, []);
  const onArrows = useCallback((v: boolean) => {
    setArrows(v);
    saveBool(ARROWS_KEY, v);
    engineRef.current?.setArrowsVisible(v);
  }, []);
  const onCurved = useCallback((v: boolean) => {
    setCurved(v);
    saveBool(CURVED_KEY, v);
    engineRef.current?.setCurved(v);
  }, []);
  const onResetView = useCallback(() => engineRef.current?.resetView(), []);
  const onToggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);

  const onNodeLimit = useCallback((v: number) => {
    setNodeLimit(v);
    nodeLimitRef.current = v;
    engineRef.current?.setNodeLimit(v);
    try {
      localStorage.setItem(NODE_LIMIT_KEY, String(v));
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
  }, []);

  // The engine lives as long as the canvas host; it is (re)attached to the store when that changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let engine: Engine | null = null;
    // lazy: three (~1 MB) stays out of the entry chunk
    import("@/engine/engine")
      .then(({ Engine }) => Engine.create(host))
      .then((e) => {
        if (cancelled) return e.dispose();
        engine = e;
        engineRef.current = e;
        e.onError = setEngineError;
        e.onGenerationReset = () => handlersRef.current.clearSelection();
        e.setHandlers({
          onHover: (hit, at) => {
            if (hit) pointerRef.current = at;
            setHover(hit);
          },
          onClick: (hit) => {
            if (hit?.kind === "node") handlersRef.current.selectNode(hit.index);
            else handlersRef.current.clearSelection();
          },
          onContextMenu: (hit) => {
            if (hit?.kind === "node") handlersRef.current.makeRoot(hit.index);
          },
        });
        e.setNodeLimit(nodeLimitRef.current);
        const st = settingsRef.current;
        if (st.dim !== 3) e.setDim(st.dim);
        e.setEdgeOpacityScale(st.edgeOpacity);
        e.setArrowsVisible(st.arrows);
        e.setCurved(st.curved);
        e.setRelationColors(paletteRef.current);
        e.attach(store);
        setEngineError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEngineError(
          err instanceof WebGpuUnavailableError
            ? WEBGPU_NOTICE
            : `The graph view could not start: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    const timer = setInterval(() => {
      setFps(engine?.fps ?? 0);
      setSettling(engine?.settling ?? false);
      setShown(Math.min(nodeLimitRef.current, store.nodeCount));
      const pend = pendingSelect.current;
      if (pend && store.generation > pend.gen) {
        const i = store.indexOf(pend.iri);
        if (i >= 0 && i < nodeLimitRef.current) {
          pendingSelect.current = null;
          handlersRef.current.focusSelect(i);
        }
      }
      if (pend && Date.now() > pend.until) pendingSelect.current = null;
      const next = groupCounts(store.groups, nodeLimitRef.current, store.groupNames.length);
      setCounts((prev) =>
        prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
      );
      const perPred = relationCounts(
        store.edges,
        store.edgePredicate,
        store.edgeCount,
        nodeLimitRef.current,
        store.predicates.length
      );
      const rel = new Map<string, number>();
      perPred.forEach((n, p) => {
        const iri = store.predicates[p];
        if (n > 0) rel.set(iri, (rel.get(iri) ?? 0) + n);
      });
      setRelCounts((prev) =>
        prev.size === rel.size && [...rel].every(([k, v]) => prev.get(k) === v) ? prev : rel
      );
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
      engineRef.current = null;
      engine?.dispose();
    };
  }, [store]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const legend = useMemo(
    () => [
      ...groups.map((g, i) => ({
        name: g.name,
        color: g.color,
        count: counts[i] ?? 0,
      })),
      {
        name: UNCLASSIFIED,
        color: NO_GROUP_COLOR,
        count: counts[groups.length] ?? 0,
      },
    ],
    [groups, counts]
  );
  /** Shown relations, most frequent first. */
  const relationLegend = useMemo(
    () =>
      [...relCounts]
        .map(([iri, count]) => ({
          name: shortName(iri),
          color: palette.get(iri) ?? NO_GROUP_COLOR,
          count,
        }))
        .sort((a, b) => b.count - a.count),
    [relCounts, palette]
  );
  const busy = !engineError && (status.phase === "streaming" || settling);
  const rootColor = groups.find((g) => g.name === rootInfo?.group)?.color ?? NO_GROUP_COLOR;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        onToggle={onToggleSidebar}
        rootIri={rootIri}
        onRoot={makeRootIri}
        root={rootInfo}
        rootColor={rootColor}
        nodeLimit={nodeLimit}
        onNodeLimit={onNodeLimit}
        depth={depth}
        onDepth={onDepth}
        fanout={fanout}
        onFanout={onFanout}
        status={status}
        shown={shown}
        fps={fps}
        settling={settling}
        legend={legend}
        relationLegend={relationLegend}
        dim={dim}
        onDim={onDim}
        edgeOpacity={edgeOpacity}
        onEdgeOpacity={onEdgeOpacity}
        arrows={arrows}
        onArrows={onArrows}
        curved={curved}
        onCurved={onCurved}
        onResetView={onResetView}
      />
      <div
        ref={wrapRef}
        tabIndex={-1}
        className="bg-background outline-none relative min-h-0 min-w-0 flex-1 overflow-hidden"
        onPointerMove={(e) => {
          pointerRef.current = { x: e.clientX, y: e.clientY };
          if (hover) placeTip();
        }}
      >
        <div ref={hostRef} className="absolute inset-0" data-slot="canvas-host" />
        {hover && !busy && <GraphTooltip ref={tipRef} store={store} hit={hover} />}
        {busy && (
          // Blocks camera input while loading/settling: the auto-fit stops at the first
          // user interaction, so moving mid-load leaves the camera off the final layout.
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 z-30 flex cursor-wait items-start justify-center bg-transparent p-4"
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="bg-background/90 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow">
              <Loader2 className="size-5 animate-spin" aria-hidden />
              <div>
                <div className="font-medium">
                  {status.phase === "streaming" ? "Loading graph…" : "Arranging layout…"}
                </div>
                <div className="text-muted-foreground text-xs">{statusText(status)}</div>
              </div>
            </div>
          </div>
        )}
        {engineError && (
          <div
            role="alert"
            className="text-muted-foreground absolute inset-0 flex items-center justify-center p-6 text-center text-sm"
          >
            {engineError}
          </div>
        )}
        {selected && (
          <NodeDetails
            sel={selected}
            legend={legend}
            isRoot={selected.iri === rootIri}
            onClose={closeDetails}
            onMakeRoot={() => {
              const i = store.nodeIds.indexOf(selected.iri);
              if (i >= 0) makeRoot(i);
            }}
          />
        )}
        <div className="absolute top-3 left-3 flex gap-1">
          {!sidebarOpen && (
            <Button
              variant="outline"
              size="icon"
              aria-label="Open sidebar"
              aria-expanded={false}
              aria-controls="sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Toggle fullscreen"
            aria-pressed={isFullscreen}
            onClick={() =>
              document.fullscreenElement
                ? void document.exitFullscreen()
                : void wrapRef.current?.requestFullscreen()
            }
          >
            {isFullscreen ? <Minimize /> : <Maximize />}
          </Button>
          <Button variant="outline" size="icon" aria-label="Reset view" onClick={onResetView}>
            <RotateCcw />
          </Button>
        </div>
      </div>
    </div>
  );
}
