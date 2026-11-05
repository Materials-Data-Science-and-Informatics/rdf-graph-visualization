import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchNode, type GraphGroupConfig, type NodeInfo } from "@/lib/api";
import type { Engine } from "@/engine/engine";
import { WEBGPU_NOTICE, WebGpuUnavailableError } from "@/engine/webgpu";
import { DEFAULT_ROOT_IRI } from "@/lib/config";
import { useGraphStream } from "@/lib/use-graph-stream";
import { shortName } from "@/lib/graph-store";
import {
  FANOUT_KEY,
  clampDepth,
  clampFanout,
  depthToMaxHops,
  fanoutParam,
  loadFanout,
  loadNodeLimit,
  saveNodeLimit,
  NARROW,
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
import { keepIfSameCounts, keepIfSameMap, windowStats } from "@/lib/graph-stats";
import { relationPalette } from "@/lib/relation-colors";
import Sidebar from "./Sidebar";
import NodeDetails, { type SelectedView } from "./NodeDetails";
import GraphTooltip from "./GraphTooltip";
import GraphOverlay from "./GraphOverlay";
import { useEscapeClose, useTipPlacement } from "./graph-view-hooks";
import GraphToolbar from "./GraphToolbar";
import Graph2D, { type ViewHandle } from "./Graph2D";
import type { GraphControl } from "./SearchBox";

const PENDING_SELECT_MS = 20000;

const DEPTH_DEBOUNCE_MS = 500;
const NO_GROUP_COLOR = "#8a8f98";
const UNCLASSIFIED = "Unclassified";

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
  const view2dRef = useRef<ViewHandle | null>(null);
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

  /** The mounted view for the current dimension (2D: cosmos.gl, 3D: GPU engine). */
  const activeView = useCallback(
    (): ViewHandle | null =>
      settingsRef.current.dim === 2 ? view2dRef.current : engineRef.current,
    []
  );

  const clearSelection = useCallback(() => {
    selectAbort.current?.abort();
    selectAbort.current = null;
    setSelected(null);
    activeView()?.setSelected(null);
  }, [activeView]);

  const selectNode = useCallback(
    (index: number) => {
      const iri = store.nodeIds[index];
      if (iri === undefined) return;
      selectAbort.current?.abort();
      const ctrl = new AbortController();
      selectAbort.current = ctrl;
      activeView()?.setSelected(index);
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
    [store, activeView]
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
      activeView()?.focusOn(i);
    },
    [selectNode, activeView]
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
  useEscapeClose(selected !== null, sidebarOpen, closeDetails, () => setSidebarOpen(false));
  const handlersRef = useRef({ selectNode, clearSelection, makeRoot, focusSelect });
  // eslint-disable-next-line react-hooks/refs -- latest-value ref read by engine callbacks
  handlersRef.current = { selectNode, clearSelection, makeRoot, focusSelect };

  const placeTip = useTipPlacement(tipRef, wrapRef, pointerRef, hover);

  const onDim = useCallback((d: 2 | 3) => {
    setDimState(d);
    savePref(DIM_KEY, String(d));
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
  const onResetView = useCallback(() => activeView()?.resetView(), [activeView]);
  const onToggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);

  const onNodeLimit = useCallback((v: number) => {
    setNodeLimit(v);
    nodeLimitRef.current = v;
    engineRef.current?.setNodeLimit(v);
    saveNodeLimit(v);
  }, []);

  // The 3D engine lives while 3D is shown; it is (re)attached to the store when that changes.
  const is3d = dim === 3;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !is3d) return;
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
    return () => {
      cancelled = true;
      engineRef.current = null;
      engine?.dispose();
    };
  }, [store, is3d]);

  // Stats poll shared by both views.
  useEffect(() => {
    const timer = setInterval(() => {
      const v = activeView();
      setFps(v?.fps ?? 0);
      setSettling(v?.settling ?? false);
      setShown(Math.min(nodeLimitRef.current, store.nodeCount));
      const pend = pendingSelect.current;
      if (pend && store.generation > pend.gen) {
        const i = store.indexOf(pend.iri);
        if (i >= 0 && i < nodeLimitRef.current) {
          pendingSelect.current = null;
          // select only: focusing the hop-0 root would stop the auto-fit before the layout spreads
          handlersRef.current.selectNode(i);
        }
      }
      if (pend && Date.now() > pend.until) pendingSelect.current = null;
      const stats = windowStats(store, nodeLimitRef.current);
      setCounts((prev) => keepIfSameCounts(prev, stats.counts));
      setRelCounts((prev) => keepIfSameMap(prev, stats.relCounts));
    }, 500);
    return () => clearInterval(timer);
  }, [store, activeView]);

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
  // 2D: block input only while streaming (the cosmos layout keeps settling interactively)
  const busy = !engineError && (status.phase === "streaming" || (dim === 3 && settling));
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
        {is3d ? (
          <div ref={hostRef} className="absolute inset-0" data-slot="canvas-host" />
        ) : (
          <Graph2D
            ref={view2dRef}
            store={store}
            nodeLimit={nodeLimit}
            streaming={status.phase === "streaming"}
            curved={curved}
            arrows={arrows}
            edgeOpacity={edgeOpacity}
            palette={palette}
            onPointClick={(i) => handlersRef.current.selectNode(i)}
            onPointContextMenu={(i) => handlersRef.current.makeRoot(i)}
            onBackgroundClick={() => handlersRef.current.clearSelection()}
            onError={setEngineError}
          />
        )}
        {hover && !busy && <GraphTooltip ref={tipRef} store={store} hit={hover} />}
        <GraphOverlay busy={busy} status={status} engineError={engineError} />
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
        <GraphToolbar
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() =>
            document.fullscreenElement
              ? void document.exitFullscreen()
              : void wrapRef.current?.requestFullscreen()
          }
          onResetView={onResetView}
        />
      </div>
    </div>
  );
}
