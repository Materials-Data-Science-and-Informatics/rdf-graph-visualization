import { useEffect, useRef, useState } from "react";
import { Maximize, Minimize, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import StatusBar from "./StatusBar";

/** Canvas host: the GPU engine mounts into the `canvas-host` div (task F2). */
export default function GraphView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  return (
    <div ref={wrapRef} className="bg-background relative min-h-0 flex-1 overflow-hidden">
      <div className="absolute inset-0" data-slot="canvas-host" />
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
        <Button variant="outline" size="icon" aria-label="Reset view" disabled>
          <RotateCcw />
        </Button>
      </div>
      <div className="absolute top-3 right-3" data-slot="legend" />
      <StatusBar />
    </div>
  );
}
