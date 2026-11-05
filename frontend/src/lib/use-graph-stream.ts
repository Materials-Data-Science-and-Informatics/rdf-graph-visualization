import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { streamGraph, type DoneReason, type GraphGroupConfig, type StreamEvent } from "./api";
import { GraphStore } from "./graph-store";

export interface StreamStatus {
  phase: "idle" | "streaming" | "done" | "error";
  hop: number;
  nodes: number;
  edges: number;
  doneReason: DoneReason | null;
  error: string | null;
  cached: boolean;
  builtAt: string | null;
}

const IDLE: StreamStatus = {
  phase: "idle",
  hop: 0,
  nodes: 0,
  edges: 0,
  doneReason: null,
  error: null,
  cached: false,
  builtAt: null,
};

const STATUS_INTERVAL_MS = 100;

/** Pure status reducer (exported for tests). Node/edge counts come from the store, not events. */
export function reduceStatus(s: StreamStatus, e: StreamEvent): StreamStatus {
  switch (e.type) {
    case "meta":
      return { ...s, cached: e.cached === true, builtAt: e.built_at ?? null };
    case "nodes":
    case "edges":
    case "progress":
      return e.hop > s.hop ? { ...s, hop: e.hop } : s;
    case "error":
      return { ...s, error: e.message };
    case "done":
      return { ...s, phase: e.reason === "error" ? "error" : "done", doneReason: e.reason };
    default:
      return s;
  }
}

/**
 * Streams a graph into a `GraphStore` (plus a mirrored `display` store read by the views). React state
 * only holds the throttled status for the status bar.
 */
export function useGraphStream(groups: readonly Pick<GraphGroupConfig, "name" | "color">[]) {
  const store = useMemo(() => new GraphStore(groups), [groups]);
  /** What the views show: mirrors `store` while streaming (see `useDisplayStore` for bundles). */
  const display = useMemo(() => new GraphStore(groups), [groups]);
  const [status, setStatus] = useState<StreamStatus>(IDLE);
  const ctrlRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
  }, []);

  const start = useCallback(
    (
      root: string,
      opts: { maxNodes?: number; maxHops?: number; maxFanout?: number; grow?: boolean } = {}
    ) => {
      abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      // `grow`: same root/depth/fanout with a bigger node budget. The backend replays the same BFS
      // prefix, so re-applied nodes/edges are no-ops and only new ones append (no reset, no new
      // generation). A bundled display is left alone: `useDisplayStore` rebuilds it after `done`.
      const mirror = !opts.grow || display.bundles.size === 0;
      if (!opts.grow) {
        store.reset();
        display.reset();
      }
      let local: StreamStatus = { ...IDLE, phase: "streaming" };
      let lastPush = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const push = () => {
        timer = undefined;
        lastPush = Date.now();
        if (ctrl.signal.aborted) return;
        setStatus({ ...local, nodes: store.nodeCount, edges: store.edgeCount });
      };
      const schedule = () => {
        if (timer !== undefined) return;
        const wait = Math.max(0, STATUS_INTERVAL_MS - (Date.now() - lastPush));
        timer = setTimeout(push, wait);
      };
      push();
      streamGraph(
        { root, maxNodes: opts.maxNodes, maxHops: opts.maxHops, maxFanout: opts.maxFanout },
        (e) => {
          if (ctrl.signal.aborted) return;
          store.apply(e);
          if (mirror) display.apply(e);
          const next = reduceStatus(local, e);
          if (next === local && e.type !== "nodes" && e.type !== "edges") return;
          local = next;
          if (e.type === "done" || e.type === "error" || e.type === "meta") {
            clearTimeout(timer);
            push();
          } else schedule();
        },
        ctrl.signal
      )
        .then(() => {
          clearTimeout(timer);
          if (local.phase === "streaming")
            local = { ...local, phase: "error", error: "Stream ended unexpectedly" };
          push();
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          if (ctrl.signal.aborted) return;
          local = {
            ...local,
            phase: "error",
            error: err instanceof Error ? err.message : String(err),
          };
          push();
        });
    },
    [abort, store, display]
  );

  useEffect(() => abort, [abort]);

  return { store, display, status, start, abort };
}

export function statusText(s?: StreamStatus): string {
  if (!s || s.phase === "idle") return "Ready";
  const counts = `${s.nodes.toLocaleString()} nodes, ${s.edges.toLocaleString()} edges`;
  const cached = s.cached ? " (cached)" : "";
  switch (s.phase) {
    case "streaming":
      return `Loading hop ${s.hop}: ${counts}${cached}`;
    case "error":
      return `Error: ${s.error ?? "stream failed"} (${counts})`;
    default:
      return `${counts}, ${s.doneReason ?? "done"}${cached}`;
  }
}
