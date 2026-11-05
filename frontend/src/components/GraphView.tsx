import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minimize, PanelLeftOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchNode, type GraphGroupConfig, type NodeInfo } from "@/lib/api";
import type { Engine } from "@/engine/engine";
import { NODE_LIMIT_DEFAULT, NODE_LIMIT_MAX, NODE_LIMIT_MIN } from "@/engine/layout-utils";
import { WEBGPU_NOTICE, WebGpuUnavailableError } from "@/engine/webgpu";
import { DEFAULT_ROOT_IRI } from "@/lib/config";
import { useGraphStream } from "@/lib/use-graph-stream";
import {
  clampDepth,
  depthToMaxHops,
  groupCounts,
  loadDepth,
  saveDepth,
} from "@/lib/sidebar-settings";
import Sidebar from "./Sidebar";

const NARROW = "(max-width: 767px)";
const DEPTH_DEBOUNCE_MS = 500;
const NO_GROUP_COLOR = "#8a8f98";

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
export default function GraphView({ groups }: { groups: GraphGroupConfig[] }) {
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
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const [rootInfo, setRootInfo] = useState<NodeInfo | null>(null);
  const [shown, setShown] = useState(0);
  const [counts, setCounts] = useState<number[]>([]);
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<number>>(new Set());
  const hiddenRef = useRef(hiddenGroups);
  const [dim, setDimState] = useState<2 | 3>(3);
  const [edgeOpacity, setEdgeOpacity] = useState(1);
  const [arrows, setArrows] = useState(true);
  const settingsRef = useRef({ dim, edgeOpacity, arrows });
  settingsRef.current = { dim, edgeOpacity, arrows };

  // Depth changes restart the stream; omitted max_hops (default 6) keeps the cached snapshot key.
  useEffect(() => {
    start(DEFAULT_ROOT_IRI, { maxHops: depthToMaxHops(appliedDepth) });
  }, [start, appliedDepth]);

  useEffect(() => {
    const t = setTimeout(() => setAppliedDepth(depth), DEPTH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [depth]);

  const onDepth = useCallback((d: number) => {
    const v = clampDepth(d);
    setDepth(v);
    saveDepth(v);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchNode(DEFAULT_ROOT_IRI, ctrl.signal)
      .then(setRootInfo)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);

  const onGroupVisible = useCallback((index: number, visible: boolean) => {
    const next = new Set(hiddenRef.current);
    if (visible) next.delete(index);
    else next.add(index);
    hiddenRef.current = next;
    setHiddenGroups(next);
    engineRef.current?.setGroupVisible(index, visible);
  }, []);
  const onDim = useCallback((d: 2 | 3) => {
    setDimState(d);
    engineRef.current?.setDim(d);
  }, []);
  const onEdgeOpacity = useCallback((v: number) => {
    setEdgeOpacity(v);
    engineRef.current?.setEdgeOpacityScale(v);
  }, []);
  const onArrows = useCallback((v: boolean) => {
    setArrows(v);
    engineRef.current?.setArrowsVisible(v);
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
        e.setNodeLimit(nodeLimitRef.current);
        const st = settingsRef.current;
        if (st.dim !== 3) e.setDim(st.dim);
        e.setEdgeOpacityScale(st.edgeOpacity);
        e.setArrowsVisible(st.arrows);
        hiddenRef.current.forEach((g) => e.setGroupVisible(g, false));
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
      const next = groupCounts(store.groups, nodeLimitRef.current, store.groupNames.length);
      setCounts((prev) =>
        prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next
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
        visible: !hiddenGroups.has(i),
      })),
      {
        name: "Unclassified",
        color: NO_GROUP_COLOR,
        count: counts[groups.length] ?? 0,
        visible: !hiddenGroups.has(-1),
      },
    ],
    [groups, counts, hiddenGroups]
  );
  const rootColor = groups.find((g) => g.name === rootInfo?.group)?.color ?? NO_GROUP_COLOR;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        onToggle={onToggleSidebar}
        rootIri={DEFAULT_ROOT_IRI}
        root={rootInfo}
        rootColor={rootColor}
        nodeLimit={nodeLimit}
        onNodeLimit={onNodeLimit}
        depth={depth}
        onDepth={onDepth}
        status={status}
        shown={shown}
        fps={fps}
        settling={settling}
        legend={legend}
        onGroupVisible={onGroupVisible}
        dim={dim}
        onDim={onDim}
        edgeOpacity={edgeOpacity}
        onEdgeOpacity={onEdgeOpacity}
        arrows={arrows}
        onArrows={onArrows}
        onResetView={onResetView}
      />
      <div ref={wrapRef} className="bg-background relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div ref={hostRef} className="absolute inset-0" data-slot="canvas-host" />
        {engineError && (
          <div
            role="alert"
            className="text-muted-foreground absolute inset-0 flex items-center justify-center p-6 text-center text-sm"
          >
            {engineError}
          </div>
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
