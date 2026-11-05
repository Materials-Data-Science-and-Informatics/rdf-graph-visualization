import { statusText, type StreamStatus } from "@/lib/use-graph-stream";

export default function StatusBar({ status, fps }: { status?: StreamStatus; fps?: number }) {
  return (
    <div className="bg-background/70 text-muted-foreground pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-3 py-1 text-xs backdrop-blur">
      <span>{statusText(status)}</span>
      {fps ? <span className="tabular-nums">{Math.round(fps)} fps</span> : null}
    </div>
  );
}
