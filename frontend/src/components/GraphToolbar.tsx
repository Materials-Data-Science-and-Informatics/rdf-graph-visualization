import { Maximize, Minimize, PanelLeftOpen, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Top-left buttons over the canvas: open sidebar (when closed), fullscreen, reset view. */
export default function GraphToolbar({
  sidebarOpen,
  onOpenSidebar,
  isFullscreen,
  onToggleFullscreen,
  onResetView,
}: {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onResetView: () => void;
}) {
  return (
    <div className="absolute top-3 left-3 flex gap-1">
      {!sidebarOpen && (
        <Button
          variant="outline"
          size="icon"
          aria-label="Open sidebar"
          aria-expanded={false}
          aria-controls="sidebar"
          onClick={onOpenSidebar}
        >
          <PanelLeftOpen />
        </Button>
      )}
      <Button
        variant="outline"
        size="icon"
        aria-label="Toggle fullscreen"
        aria-pressed={isFullscreen}
        onClick={onToggleFullscreen}
      >
        {isFullscreen ? <Minimize /> : <Maximize />}
      </Button>
      <Button variant="outline" size="icon" aria-label="Reset view" onClick={onResetView}>
        <RotateCcw />
      </Button>
    </div>
  );
}
