import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import Content from "./components/Content.tsx";
import Layout from "./components/Layout.tsx";
import LoadingSpinner from "./components/LoadingSpinner.tsx";
import { loadConfig } from "./config";

type ConfigState =
  { status: "loading" } | { status: "ready" } | { status: "error"; message: string };

/**
 * Card C4: the renderer config (palette, relation/label properties) is
 * fetched at runtime from /api/config — nothing is baked in at build time,
 * so a config change on the serving backend shows up without a frontend
 * rebuild. The UI mounts only once the config is in; a failed config fetch
 * is surfaced instead of rendering uncoloured/legless graph chrome.
 */
function App() {
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    loadConfig(controller.signal)
      .then(() => setConfigState({ status: "ready" }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setConfigState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, []);

  if (configState.status === "loading") {
    return <LoadingSpinner />;
  }

  if (configState.status === "error") {
    return (
      <div className="mx-auto mt-12 max-w-[40rem] p-8">
        <div
          role="alert"
          className="flex items-start gap-3 rounded-[6px] border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950"
        >
          <AlertCircle
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
          />
          <div className="flex-1">
            <p className="font-bold">Could not load graph configuration</p>
            <span
              className="mt-1 block text-sm text-red-700 dark:text-red-300"
              data-testid="config-error"
            >
              {configState.message}
            </span>
          </div>
        </div>
        <Button className="mt-4" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Layout>
      <Content />
    </Layout>
  );
}

export default App;
