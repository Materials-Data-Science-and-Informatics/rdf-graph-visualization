import { describe, expect, it } from "vitest";
import { bucketParam, fetchBucket } from "./fetch-bucket";

describe("fetchBucket", () => {
  it("picks the smallest bucket that holds the node count", () => {
    expect(fetchBucket(50)).toBe(1_000);
    expect(fetchBucket(1_000)).toBe(1_000);
    expect(fetchBucket(1_001)).toBe(5_000);
    expect(fetchBucket(5_000)).toBe(5_000);
    expect(fetchBucket(20_000)).toBe(20_000);
    expect(fetchBucket(20_001)).toBe(100_000);
    expect(fetchBucket(500_000)).toBe(100_000);
  });
  it("omits the param at the backend default", () => {
    expect(bucketParam(100_000)).toBeUndefined();
    expect(bucketParam(5_000)).toBe(5_000);
  });
});
