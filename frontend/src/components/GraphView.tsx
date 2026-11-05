import { useEffect, useRef, useState } from "react";
import { Maximize, Minimize, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GraphGroupConfig } from "@/lib/api";
import type { Engine } from "@/engine/engine";
import { WEBGPU_NOTICE, WebGpuUnavailableError } from "@/engine/webgpu";
import { DEFAULT_ROOT_IRI } from "@/lib/config";
import { useGraphStream } from "@/lib/use-graph-stream";
import StatusBar from "./StatusBar";

/** Canvas host: the GPU engine mounts into the `canvas-host` div and pulls deltas from the stream's store. */
export default function GraphView({ groups }: { groups: GraphGroupConfig[] }) {
  const { store, status, start } = useGraphStream(groups);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [fps, setFps] = useState(0);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [isFullscreen, setFullscreen] = useState(false);

  useEffect(() => start(DEFAULT_ROOT_IRI), [start]);

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
    const timer = setInterval(() => setFps(engine?.fps ?? 0), 500);
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
      <div className="absolute top-3 left-3 flex gap-1">
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
      <div className="absolute top-3 right-3" data-slot="legend" />
      <StatusBar status={status} fps={fps} />
    </div>
  );
}
