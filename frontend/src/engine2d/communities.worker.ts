/** Worker protocol: in {id, n, pairs (transferred)}, out {id, ...Communities (transferred)}. */
import { detectCommunities, type Communities } from "./communities";

export interface CommunityRequest {
  id: number;
  n: number;
  pairs: Uint32Array;
}
export type CommunityResponse = { id: number } & Communities;

self.onmessage = (e: MessageEvent<CommunityRequest>) => {
  const { id, n, pairs } = e.data;
  const r = detectCommunities(pairs, n);
  const out: CommunityResponse = { id, ...r };
  const buffers = [r.community.buffer, r.hubs.buffer, r.sizes.buffer] as ArrayBuffer[];
  (self as unknown as Worker).postMessage(out, buffers);
};
