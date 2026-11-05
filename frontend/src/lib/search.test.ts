import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce, groupForResult, shortIri, wrapIndex } from "./search";

afterEach(() => vi.useRealTimers());

describe("groupForResult", () => {
  const groups = [{ name: "Person", color: "#f00" }];
  it("maps type to group", () =>
    expect(groupForResult({ type: "Person" }, groups)?.color).toBe("#f00"));
  it("null when unmapped", () => expect(groupForResult({ type: "Unknown" }, groups)).toBeNull());
});

describe("wrapIndex", () => {
  it("wraps both ways", () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 3)).toBe(1);
  });
  it("starts at the ends from -1 and handles empty", () => {
    expect(wrapIndex(-1, 1, 3)).toBe(0);
    expect(wrapIndex(-1, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 0)).toBe(-1);
  });
});

describe("shortIri", () => {
  it("drops scheme", () => expect(shortIri("https://ror.org/0281dp749")).toBe("ror.org/0281dp749"));
  it("keeps non-http", () => expect(shortIri("urn:x:1")).toBe("urn:x:1"));
});

describe("debounce", () => {
  it("fires once with the last args and can cancel", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d(1);
    d(2);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
    d(3);
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
