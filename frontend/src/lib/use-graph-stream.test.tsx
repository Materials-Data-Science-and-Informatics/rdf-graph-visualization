// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGraphStream } from "./use-graph-stream";

afterEach(() => vi.unstubAllGlobals());

describe("useGraphStream", () => {
  it("starts, reports an unexpected end, and aborts on unmount", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return Promise.resolve(new Response('{"type":"nodes","hop":0,"nodes":[{"id":"r"}]}\n'));
      })
    );
    let api!: ReturnType<typeof useGraphStream>;
    const groups: { name: string; color: string }[] = [];
    function Probe() {
      api = useGraphStream(groups);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      api.start("r");
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(api.store.nodeCount).toBe(1);
    expect(api.status.phase).toBe("error");
    expect(api.status.error).toBe("Stream ended unexpectedly");
    await act(async () => {
      api.start("r2");
    });
    expect(signals[0].aborted).toBe(true);
    await act(async () => root.unmount());
    expect(signals[1].aborted).toBe(true);
  });
});
