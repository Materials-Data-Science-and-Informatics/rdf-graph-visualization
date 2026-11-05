import { Check, Maximize, Minimize, PanelLeftOpen, RotateCcw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildShareUrl } from "@/lib/url-params";
import { useCopy } from "@/lib/use-copy";

type ShareState = Parameters<typeof buildShareUrl>[1];

/** Top-left buttons over the canvas: open sidebar (when closed), fullscreen, reset view. */
export default function GraphToolbar({
  sidebarOpen,
  onOpenSidebar,
  isFullscreen,
  onToggleFullscreen,
  onResetView,
  share,
}: {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onResetView: () => void;
  /** Current view settings, encoded into the copied link. */
  share: ShareState;
}) {
  const { done, copy } = useCopy((url) => window.prompt("Copy this link", url));
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
      <Button
        variant="outline"
        size="icon"
        aria-label="Copy link to this view"
        title="Copy link to this view"
        onClick={() =>
          copy(buildShareUrl(window.location.origin + window.location.pathname, share))
        }
      >
        {done ? <Check /> : <Share2 />}
      </Button>
    </div>
  );
}
