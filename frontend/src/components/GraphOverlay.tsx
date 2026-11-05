import { Loader2 } from "lucide-react";
import { statusText, type StreamStatus } from "@/lib/use-graph-stream";

/** Loading/arranging blocker and engine error notice drawn over the canvas. */
export default function GraphOverlay({
  busy,
  status,
  engineError,
}: {
  busy: boolean;
  status: StreamStatus;
  engineError: string | null;
}) {
  return (
    <>
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
    </>
  );
}
