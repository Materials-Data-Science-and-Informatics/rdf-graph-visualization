import { statusText, type StreamStatus } from "@/lib/use-graph-stream";

export default function StatusBar({ status }: { status?: StreamStatus }) {
  return (
    <div className="bg-background/70 text-muted-foreground pointer-events-none absolute inset-x-0 bottom-0 px-3 py-1 text-xs backdrop-blur">
      {statusText(status)}
    </div>
  );
}
