import { useEffect, useRef, useState } from "react";
import { Maximize, Minimize, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GraphGroupConfig } from "@/lib/api";
import type { Engine } from "@/engine/engine";
import {
  NODE_LIMIT_DEFAULT,
  NODE_LIMIT_MAX,
  NODE_LIMIT_MIN,
  countToSlider,
  sliderToCount,
} from "@/engine/layout-utils";
import { WEBGPU_NOTICE, WebGpuUnavailableError } from "@/engine/webgpu";
import { DEFAULT_ROOT_IRI } from "@/lib/config";
import { useGraphStream } from "@/lib/use-graph-stream";
import StatusBar from "./StatusBar";

/** Canvas host: the GPU engine mounts into the `canvas-host` div and pulls deltas from the stream's store. */
const NODE_LIMIT_KEY = "hkg-node-limit";
const loadNodeLimit = (): number => {
  try {
    const v = Number(localStorage.getItem(NODE_LIMIT_KEY));
    return v >= NODE_LIMIT_MIN && v <= NODE_LIMIT_MAX ? v : NODE_LIMIT_DEFAULT;
  } catch {
    return NODE_LIMIT_DEFAULT;
  }
};

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

  useEffect(() => start(DEFAULT_ROOT_IRI), [start]);

  const onNodeLimit = (t: number) => {
    const v = sliderToCount(t);
    setNodeLimit(v);
    nodeLimitRef.current = v;
    engineRef.current?.setNodeLimit(v);
    try {
      localStorage.setItem(NODE_LIMIT_KEY, String(v));
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
  };

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

  return (
    <div ref={wrapRef} className="bg-background relative min-h-0 flex-1 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" data-slot="canvas-host" />
      {engineError && (
        <div
          role="alert"
          className="text-muted-foreground absolute inset-0 flex items-center justify-center p-6 text-center text-sm"
        >
          {engineError}
        </div>
      )}
      <div className="absolute top-3 left-3 flex flex-col gap-2">
        <div className="flex gap-1">
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
          <Button
            variant="outline"
            size="icon"
            aria-label="Reset view"
            onClick={() => engineRef.current?.resetView()}
          >
            <RotateCcw />
          </Button>
        </div>
        <label className="bg-background/70 text-muted-foreground flex items-center gap-2 rounded-md border px-2 py-1 text-xs backdrop-blur">
          Show
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={countToSlider(nodeLimit)}
            aria-label="Number of nodes shown"
            className="accent-primary w-32"
            onChange={(e) => onNodeLimit(Number(e.target.value))}
          />
          <span className="w-20 tabular-nums">{nodeLimit.toLocaleString()} nodes</span>
        </label>
      </div>
      <div className="absolute top-3 right-3" data-slot="legend" />
      <StatusBar status={status} fps={fps} settling={settling} />
    </div>
  );
}
