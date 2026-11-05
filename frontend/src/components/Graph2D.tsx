import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { CosmosView } from "@/engine2d/cosmos-view";
import type { GraphStore } from "@/lib/graph-store";

const POLL_MS = 400;

/** What GraphView needs from whichever view is active (the 3D Engine satisfies it too). */
export interface ViewHandle {
  setSelected(index: number | null): void;
  focusOn(index: number): void;
  resetView(): void;
  readonly fps: number;
  readonly settling: boolean;
}

interface Graph2DProps {
  store: GraphStore;
  nodeLimit: number;
  curved: boolean;
  arrows: boolean;
  edgeOpacity: number;
  palette: ReadonlyMap<string, string>;
  onPointClick: (index: number) => void;
  onPointContextMenu: (index: number) => void;
  onBackgroundClick: () => void;
  onError: (message: string | null) => void;
  ref: Ref<ViewHandle>;
}

/** 2D mode: cosmos.gl canvas over the same GraphStore the 3D engine reads. */
export default function Graph2D(p: Graph2DProps) {
  const { ref, palette, curved, arrows, edgeOpacity } = p;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CosmosView | null>(null);
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });

  useImperativeHandle(
    ref,
    () => ({
      setSelected: (i) => viewRef.current?.setSelected(i),
      focusOn: (i) => viewRef.current?.focusOn(i),
      resetView: () => viewRef.current?.resetView(),
      get fps() {
        return viewRef.current?.fps ?? 0;
      },
      get settling() {
        return viewRef.current?.settling ?? false;
      },
    }),
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let view: CosmosView | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    // lazy: cosmos.gl stays out of the entry chunk
    import("@/engine2d/cosmos-view")
      .then(({ CosmosView }) => {
        if (cancelled) return;
        const l = latest.current;
        view = new CosmosView(
          host,
          {
            onPointClick: (i) => latest.current.onPointClick(i),
            onPointContextMenu: (i) => latest.current.onPointContextMenu(i),
            onBackgroundClick: () => latest.current.onBackgroundClick(),
          },
          { curved: l.curved, arrows: l.arrows, edgeOpacity: l.edgeOpacity }
        );
        viewRef.current = view;
        view.setPalette(l.palette);
        l.onError(null);
        timer = setInterval(() => {
          const c = latest.current;
          view?.sampleFps();
          view?.poll(c.store, c.nodeLimit);
        }, POLL_MS);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          latest.current.onError(
            `The 2D graph view could not start: ${err instanceof Error ? err.message : String(err)}`
          );
      });
    return () => {
      cancelled = true;
      clearInterval(timer);
      viewRef.current = null;
      view?.destroy();
    };
  }, []);

  useEffect(() => {
    viewRef.current?.setOptions({ curved, arrows, edgeOpacity });
  }, [curved, arrows, edgeOpacity]);
  useEffect(() => {
    viewRef.current?.setPalette(palette);
  }, [palette]);

  return <div ref={hostRef} className="absolute inset-0" data-slot="canvas-host-2d" />;
}
