import { describe, expect, it } from "vitest";
import { buildShareUrl, readUrlParams } from "./url-params";

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
      nodes: 50,
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

describe("buildShareUrl", () => {
  const base = { root: "https://example.org/r", nodes: 2000, depth: 3, fanout: 0, dim: 2 as const };
  it("round-trips through readUrlParams", () => {
    const select = "https://example.org/a#x";
    const url = buildShareUrl("http://h/app", { ...base, select });
    expect(readUrlParams(url.slice(url.indexOf("?")))).toEqual({ ...base, select });
  });
  it("omits select when absent or a bundle", () => {
    expect(buildShareUrl("http://h/", base)).not.toContain("select");
    expect(buildShareUrl("http://h/", { ...base, select: "urn:hkg:bundle:abc" })).not.toContain(
      "select"
    );
  });
});
