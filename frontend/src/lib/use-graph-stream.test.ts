import { describe, expect, it } from "vitest";
import { reduceStatus, type StreamStatus } from "./use-graph-stream";

const base: StreamStatus = {
  phase: "streaming",
  hop: 0,
  nodes: 0,
  edges: 0,
  doneReason: null,
  error: null,
  cached: false,
  builtAt: null,
};

describe("reduceStatus", () => {
  it("tracks meta, hop and done", () => {
    let s = reduceStatus(base, {
      type: "meta",
      root: "r",
      max_nodes: 1,
      max_hops: 1,
      cached: true,
      built_at: "t",
    });
    expect([s.cached, s.builtAt]).toEqual([true, "t"]);
    s = reduceStatus(s, { type: "progress", hop: 2, nodes: 1, edges: 0 });
    expect(s.hop).toBe(2);
    expect(reduceStatus(s, { type: "ping" })).toBe(s);
    expect(reduceStatus(s, { type: "done", reason: "truncated" }).phase).toBe("done");
    expect(reduceStatus(s, { type: "done", reason: "error" }).phase).toBe("error");
  });
});
