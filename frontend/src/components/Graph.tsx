// Card D4 — renderer-agnostic Graph view.
//
// This component no longer hard-wires react-force-graph-3d: it drives a
// registered GraphRenderer (card D1 contract, src/render/CONTRACT.md)
// through use-graph-renderer, and the D4 toggle switches the engine at
// runtime — no refetch, no relayout, no lost selection (see that hook).
// The legacy 3D force graph is retired as the app view; sigma 2D is the
// default engine, cosmos 2D-GPU the alternative.
//
// Card C3 note: the cam/look URL keys were force-graph-3d camera state. The
// contract keeps the camera renderer-owned and never serialized (V1), so
// those keys are no longer written. Old shared URLs still load (the keys
// parse and are ignored); a 2D camera URL format is a C3 follow-up.

import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import type { RendererGraph } from "../render";
import { initialViewState, updateSearchKeys } from "../view-state";
import EngineToggle from "./EngineToggle.tsx";
import FullScreenButton from "./FullScreenButton.tsx";
import Legend from "./Legend.tsx";
import ResetViewButton from "./ResetViewButton.tsx";
import ThemeSwitch from "./ThemeSwitch.tsx";
import { useGraphRenderer } from "./use-graph-renderer";

interface GraphProps {
  /** The current filtered graph (fresh copies; the renderer owns what it gets). */
  graphData: RendererGraph;
  width: number;
  height: number;
  /** Optional node activation hook (card C2: select/focus/expand-on-click). */
  onNodeSelect?: (nodeId: string) => void;
}

const Graph: React.FC<GraphProps> = ({ graphData, width, height, onNodeSelect }) => {
  // Fullscreen state for graph container
  const [isFullScreen, setIsFullScreen] = useState(false);
  // Separate width/height state to allow fullscreen to override parent dimensions
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);
  // Theme toggle: dark mode (default) vs light mode. Card C3: initial value
  // comes from the opened URL; changes are written back (replaceState).
  const [switchOn, setSwitchOn] = useState<boolean>(initialViewState.theme === "light");

  useEffect(() => {
    updateSearchKeys({ theme: switchOn ? "light" : null });
  }, [switchOn]);

  // Card C0 S4: drive the Tailwind dark variant from the same state — the
  // CSS-variable theme in index.css (:root vs .dark) follows the toggle.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", !switchOn);
  }, [switchOn]);

  // Card D4: the mounted renderer (registry factory → GraphRenderer), the
  // engine toggle, and the store-driven data/focus/resize wiring.
  const { containerRef, engineId, setEngineId, engines, resetView } = useGraphRenderer({
    graph: graphData,
    onNodeSelect,
    width: graphWidth,
    height: graphHeight,
    theme: switchOn ? "light" : "dark",
  });

  // Update dimensions when fullscreen or parent dimensions change
  useEffect(() => {
    if (isFullScreen) {
      setGraphWidth(window.innerWidth);
      setGraphHeight(window.innerHeight);
    } else {
      setGraphWidth(width);
      setGraphHeight(height);
    }
  }, [isFullScreen, width, height]);

  // Stable callbacks for child components to prevent unnecessary re-renders
  const setIsFullScreenCallback = useCallback((val: boolean) => setIsFullScreen(val), []);
  const setSwitchOnCallback = useCallback((val: boolean) => setSwitchOn(val), []);

  return (
    <div
      style={{
        width: isFullScreen ? "100vw" : graphWidth,
        height: isFullScreen ? "100vh" : graphHeight,
      }}
      className={isFullScreen ? "fixed inset-0 z-[9999]" : "relative"}
    >
      <div ref={containerRef} className="absolute inset-0" data-testid="graph-container" />
      <EngineToggle engines={engines} activeId={engineId} onSelect={setEngineId} />
      <FullScreenButton isFullScreen={isFullScreen} setIsFullScreen={setIsFullScreenCallback} />
      <ResetViewButton resetView={resetView} />
      <ThemeSwitch switchOn={switchOn} setSwitchOn={setSwitchOnCallback} />
      <Legend />
    </div>
  );
};

export default Graph;
