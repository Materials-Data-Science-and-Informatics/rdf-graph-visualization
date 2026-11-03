// Card D2 S2 — ambient typing for the ONE Node built-in the layout worker
// references (lazy, @vite-ignore'd, executed only under Node worker_threads
// in the headless test path). The project has no @types/node and none is
// needed: everything else in the worker stays on the DOM runtime.
declare module "node:worker_threads" {
  export interface ParentPortLike {
    on(event: "message", cb: (data: unknown) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  }
  export const parentPort: ParentPortLike | null;
}
