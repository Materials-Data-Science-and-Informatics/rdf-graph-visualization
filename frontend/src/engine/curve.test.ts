import { describe, expect, it } from "vitest";
import {
  bezierPoint,
  bezierTangent,
  controlPoint,
  edgeColorSource,
  edgePerp,
  UNTYPED_ALPHA,
} from "./curve";

describe("curve helpers", () => {
  it("bezier hits endpoints and midpoint", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [10, 0, 0];
    const c = controlPoint(a, b, 0.3);
    expect(bezierPoint(a, c, b, 0)).toEqual(a);
    expect(bezierPoint(a, c, b, 1)).toEqual(b);
    const m = bezierPoint(a, c, b, 0.5);
    expect(m[0]).toBeCloseTo(5);
    expect(Math.abs(m[1])).toBeCloseTo(0.5 * 0.3 * 10); // half the control offset
  });
  it("tangent at the ends points toward the control point", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [10, 0, 0];
    const c = controlPoint(a, b, 0.3);
    expect(bezierTangent(a, c, b, 0)).toEqual([10, c[1] * 2, 0]);
    expect(bezierTangent(a, c, b, 1)[0]).toBeCloseTo(10);
  });
  it("zero curvature is the straight line", () => {
    const c = controlPoint([0, 0, 0], [4, 2, 0], 0);
    expect(c).toEqual([2, 1, 0]);
  });
  it("reversed edges bend to opposite sides", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [10, 3, 2];
    const p = edgePerp(a, b);
    const q = edgePerp(b, a);
    for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(-q[k]);
    expect(Math.hypot(...p)).toBeCloseTo(1);
  });
  it("falls back when the edge is parallel to z", () => {
    const p = edgePerp([0, 0, 0], [0, 0, 5]);
    expect(Number.isFinite(p[0] + p[1] + p[2])).toBe(true);
    expect(Math.hypot(...p)).toBeCloseTo(1);
    expect(p[0] * 0 + p[2]).toBeCloseTo(0); // perpendicular to z
  });
  it("edge colour: source, else target, else fallback", () => {
    expect(edgeColorSource(1, 1)).toBe(0);
    expect(edgeColorSource(UNTYPED_ALPHA, 1)).toBe(1);
    expect(edgeColorSource(UNTYPED_ALPHA, UNTYPED_ALPHA)).toBe(-1);
  });
});
