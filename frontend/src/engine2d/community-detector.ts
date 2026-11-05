/** Debounced, latest-wins client for the Louvain worker. */
import type { Communities } from "./communities";
import type { CommunityRequest, CommunityResponse } from "./communities.worker";

const DEBOUNCE_MS = 500;

export class CommunityDetector {
  private readonly worker = new Worker(new URL("./communities.worker.ts", import.meta.url), {
    type: "module",
  });
  private reqId = 0;
  private key: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onResult: (r: Communities) => void) {
    this.worker.onmessage = (e: MessageEvent<CommunityResponse>) => {
      if (e.data.id === this.reqId) this.onResult(e.data); // older requests are stale
    };
  }

  /** Runs `build()` after the debounce unless `key` is unchanged since the last call. */
  schedule(key: string, build: () => { n: number; pairs: Uint32Array }): void {
    if (key === this.key) return;
    this.key = key;
    clearTimeout(this.timer);
    this.reqId++;
    this.timer = setTimeout(() => {
      const { n, pairs } = build();
      const req: CommunityRequest = { id: ++this.reqId, n, pairs };
      this.worker.postMessage(req, [pairs.buffer]);
    }, DEBOUNCE_MS);
  }

  /** Drops any pending or in-flight request (new data set). */
  cancel(): void {
    this.key = null;
    this.reqId++;
    clearTimeout(this.timer);
  }

  destroy(): void {
    this.cancel();
    this.worker.terminate();
  }
}
