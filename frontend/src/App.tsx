import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import GraphView from "@/components/GraphView";
import TopBar from "@/components/TopBar";
import { useConfig } from "@/lib/use-config";

export default function App() {
  const cfg = useConfig();

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      {cfg.status === "ready" ? (
        <GraphView groups={cfg.config.graph.groups} />
      ) : (
        <main className="flex flex-1 items-center justify-center">
          {cfg.status === "loading" ? (
            <Loader2 className="text-muted-foreground size-8 animate-spin" aria-label="Loading" />
          ) : (
            <div role="alert" className="bg-card max-w-sm space-y-3 rounded-xl border p-5">
              <h2 className="font-semibold">Could not load configuration</h2>
              <p className="text-muted-foreground text-sm break-words">{cfg.message}</p>
              <Button onClick={cfg.retry}>Retry</Button>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
