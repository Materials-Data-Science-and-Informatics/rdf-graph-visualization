import { describe, expect, it } from "vitest";
import { effectiveDim } from "./use-webgpu-support";

describe("effectiveDim", () => {
  it("keeps 3D only with WebGPU and a working engine", () => {
    expect(effectiveDim(3, true, false)).toBe(3);
    expect(effectiveDim(3, false, false)).toBe(2);
    expect(effectiveDim(3, true, true)).toBe(2);
  });
  it("waits for the check only when 3D is requested", () => {
    expect(effectiveDim(3, null, false)).toBeNull();
    expect(effectiveDim(2, null, false)).toBe(2);
  });
});
