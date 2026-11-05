import { describe, expect, it } from "vitest";
import {
  applyCarry,
  buildCarryMap,
  choosePick,
  classifyPointer,
  decodePickId,
  encodePickId,
} from "./picking";

const put = (px: Uint8Array, p: number, v: number) => {
  px[p * 4] = v & 255;
  px[p * 4 + 1] = (v >>> 8) & 255;
  px[p * 4 + 2] = (v >>> 16) & 255;
  px[p * 4 + 3] = (v >>> 24) & 255;
};

describe("pick ids", () => {
  it("round-trips nodes and edges, 0 is nothing", () => {
    for (const index of [0, 1, 255, 256, 99_999, 0xfffffe]) {
      expect(decodePickId(encodePickId("node", index))).toEqual({ kind: "node", index });
      expect(decodePickId(encodePickId("edge", index))).toEqual({ kind: "edge", index });
    }
    expect(decodePickId(0)).toBeNull();
    expect(encodePickId("node", 0)).toBe(1);
  });
});

describe("choosePick", () => {
  it("prefers any node over a nearer edge", () => {
    const px = new Uint8Array(5 * 5 * 4);
    put(px, 12, encodePickId("edge", 7)); // centre
    put(px, 0, encodePickId("node", 3)); // corner
    expect(choosePick(px, 5)).toEqual({ kind: "node", index: 3 });
  });
  it("takes the nearest of several nodes, falls back to edges, else null", () => {
    const px = new Uint8Array(3 * 3 * 4);
    expect(choosePick(px, 3)).toBeNull();
    put(px, 0, encodePickId("edge", 1));
    put(px, 1, encodePickId("edge", 2));
    expect(choosePick(px, 3)).toEqual({ kind: "edge", index: 2 });
    put(px, 0, encodePickId("node", 5));
    put(px, 4, encodePickId("node", 6));
    expect(choosePick(px, 3)).toEqual({ kind: "node", index: 6 });
  });
});

describe("classifyPointer", () => {
  it("separates clicks from drags and holds", () => {
    const d = { x: 10, y: 10, t: 0 };
    expect(classifyPointer(d, { x: 12, y: 12, t: 120 })).toBe("click");
    expect(classifyPointer(d, { x: 30, y: 10, t: 100 })).toBe("drag");
    expect(classifyPointer(d, { x: 10, y: 10, t: 5000 })).toBe("click"); // mouse: no time limit
    expect(classifyPointer(d, { x: 10, y: 10, t: 501 }, 5, 500)).toBe("drag"); // touch: limited
  });
});

describe("position carry-over", () => {
  it("applies known ids and flags them", () => {
    const old = new Float32Array([1, 2, 3, 1, 4, 5, 6, 1]);
    const carry = buildCarryMap(["a", "b"], old);
    expect(carry.get("b")).toEqual([4, 5, 6]);
    const pos = new Float32Array(16);
    const init = new Float32Array(16).fill(9);
    const got = applyCarry(["x", "b", "a", "y"], 0, 4, carry, pos, init);
    expect(got).toEqual([1, 2]);
    expect(Array.from(pos.subarray(4, 8))).toEqual([4, 5, 6, 1]);
    expect(Array.from(pos.subarray(8, 12))).toEqual([1, 2, 3, 1]);
    expect([init[2], init[6], init[10], init[14]]).toEqual([0, 1, 1, 0]);
  });
  it("only touches the requested range", () => {
    const carry = buildCarryMap(["a"], new Float32Array([1, 1, 1, 1]));
    const pos = new Float32Array(8);
    const init = new Float32Array(8);
    expect(applyCarry(["a", "a"], 1, 2, carry, pos, init)).toEqual([1]);
    expect(pos[0]).toBe(0);
  });
});
