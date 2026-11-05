import { NODE_LIMIT_MAX, NODE_LIMIT_MIN } from "@/engine/layout-utils";
import { clampDepth, clampFanout } from "./sidebar-settings";

/** Settings taken from the page URL (`?root=…&nodes=…`); only valid, present values appear. */
export interface UrlParams {
  root?: string;
  nodes?: number;
  depth?: number;
  fanout?: number;
  dim?: 2 | 3;
  select?: string;
}

const IRI = /^https?:\/\/\S+$/;

function int(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const v = Number(raw);
  return Number.isFinite(v) ? v : undefined;
}

/** Parse URL query parameters; out-of-range numbers are clamped, invalid values ignored. */
export function readUrlParams(search: string): UrlParams {
  const q = new URLSearchParams(search);
  const out: UrlParams = {};
  const root = q.get("root")?.trim();
  if (root && IRI.test(root)) out.root = root;
  const select = q.get("select")?.trim();
  if (select && IRI.test(select)) out.select = select;
  const nodes = int(q.get("nodes"));
  if (nodes !== undefined) {
    out.nodes = Math.min(NODE_LIMIT_MAX, Math.max(NODE_LIMIT_MIN, Math.round(nodes)));
  }
  const depth = int(q.get("depth"));
  if (depth !== undefined) out.depth = clampDepth(depth);
  const fanout = int(q.get("fanout"));
  if (fanout !== undefined) out.fanout = clampFanout(fanout);
  const dim = q.get("dim");
  if (dim === "2") out.dim = 2;
  else if (dim === "3") out.dim = 3;
  return out;
}
