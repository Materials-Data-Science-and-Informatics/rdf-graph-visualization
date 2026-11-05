import { describe, expect, it } from "vitest";
import { readUrlParams } from "./url-params";

describe("readUrlParams", () => {
  it("reads valid values", () => {
    const iri = "https://example.org/a";
    expect(
      readUrlParams(
        `?root=${encodeURIComponent(iri)}&nodes=2000&depth=3&fanout=0&dim=2&select=${encodeURIComponent(iri)}`
      )
    ).toEqual({ root: iri, nodes: 2000, depth: 3, fanout: 0, dim: 2, select: iri });
  });
  it("clamps out-of-range numbers", () => {
    expect(readUrlParams("?nodes=5&depth=99&fanout=-4")).toEqual({
      nodes: 500,
      depth: 8,
      fanout: 0,
    });
    expect(readUrlParams("?nodes=999999999").nodes).toBe(100_000);
  });
  it("ignores invalid values", () => {
    expect(
      readUrlParams("?root=javascript:alert(1)&select=nope&nodes=abc&depth=&fanout=x&dim=4")
    ).toEqual({});
    expect(readUrlParams("")).toEqual({});
  });
});
