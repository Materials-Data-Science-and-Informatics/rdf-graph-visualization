import { useCallback, useEffect, useState } from "react";
import { fetchConfig, type ConfigResponse } from "./api";

export type ConfigState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; config: ConfigResponse };

export function useConfig(): ConfigState & { retry: () => void } {
  const [state, setState] = useState<ConfigState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchConfig(ctrl.signal)
      .then((config) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", config });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => ctrl.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { ...state, retry };
}
