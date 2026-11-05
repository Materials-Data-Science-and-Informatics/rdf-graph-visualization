import { useCallback, useEffect, useRef, useState } from "react";

/** Debounce for settings that restart the stream (depth, fanout, fetch bucket). */
export const DEPTH_DEBOUNCE_MS = 500;

/** Node budgets requested from the backend; the largest is the backend's own default. */
export const FETCH_BUCKETS = [1_000, 5_000, 20_000, 100_000] as const;
const BACKEND_DEFAULT_BUCKET = 100_000;

/** Smallest bucket that holds `nodeLimit` nodes. */
export function fetchBucket(nodeLimit: number): number {
  return FETCH_BUCKETS.find((b) => b >= nodeLimit) ?? FETCH_BUCKETS[FETCH_BUCKETS.length - 1];
}

/** `max_nodes` query value for a bucket; undefined at the backend default (keeps its cache key). */
export function bucketParam(bucket: number): number | undefined {
  return bucket === BACKEND_DEFAULT_BUCKET ? undefined : bucket;
}

/**
 * The bucket to stream. Lowering `nodeLimit` never changes it (client-side window); raising it above
 * the current bucket switches to the bigger one after a debounce (the stream then grows the graph
 * in place, see `useGrowTracker`). A new `streamKey` (root/depth/fanout) starts over at the needed bucket.
 */
export function useFetchBucket(nodeLimit: number, streamKey: string): number {
  const [st, setSt] = useState(() => ({ key: streamKey, bucket: fetchBucket(nodeLimit) }));
  let cur = st;
  if (st.key !== streamKey) {
    // new root/depth/fanout: start over at the bucket the current node count needs
    cur = { key: streamKey, bucket: fetchBucket(nodeLimit) };
    setSt(cur);
  }
  const wanted = fetchBucket(nodeLimit);
  useEffect(() => {
    if (wanted <= cur.bucket) return;
    const t = setTimeout(() => {
      setSt({ key: streamKey, bucket: wanted });
    }, DEPTH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [wanted, cur.bucket, streamKey]);
  return cur.bucket;
}

/**
 * Returns `(streamKey, bucket) => grow`: true when only the bucket got bigger since the previous call
 * (same root/depth/fanout), i.e. the new stream is a longer prefix of the same BFS and can be merged
 * into the existing graph instead of replacing it.
 */
export function useGrowTracker(): (streamKey: string, bucket: number) => boolean {
  const last = useRef<{ key: string; bucket: number } | null>(null);
  return useCallback((key, bucket) => {
    const grow = last.current?.key === key && bucket > last.current.bucket;
    last.current = { key, bucket };
    return grow;
  }, []);
}
