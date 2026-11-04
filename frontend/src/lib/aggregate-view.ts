// Card E3 — Aggregate cluster layer: pure model + data shaping (no React/DOM).
//
// /api/aggregate (card B4) folds the whole dataset into <= 9 rows
// {group, type, count} (B4 serves group === type; "Unknown" is one pinned
// bucket). The landing renders those rows as typed CLUSTER nodes — one node
// per data-model class, sized by count — instead of millions of entity
// nodes. Clicking a cluster is the entry point to a typed /api/subgraph
// slice (card E3 S2).
//
// This module is pure: contract validation, deterministic shaping into
// renderer data, and the small display/sizing math. No fetch, no React, no
// DOM — it bundles into headless tests as-is.

import type { AggregateNode, AggregateResponse, NodeType } from "../api/types";
import { getGroupColor } from "../config";
import type { RendererGraph, RendererLink, RendererNode } from "../render/renderer";

/** Prefix of every cluster node id ("cluster:Person"). */
export const CLUSTER_ID_PREFIX = "cluster:";

/** Node id for one aggregate row. */
export function clusterId(type: string): string {
  return `${CLUSTER_ID_PREFIX}${type}`;
}

/** The cluster type a node id belongs to (null for non-cluster ids). */
export function clusterType(id: string): string | null {
  return id.startsWith(CLUSTER_ID_PREFIX) ? id.slice(CLUSTER_ID_PREFIX.length) : null;
}

/** Compact, deterministic count label: "0".."999" digit-grouped, then k/M/B. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`formatCount: bad count ${n}`);
  const int = Math.trunc(n);
  if (int < 10_000) return int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const scaled = (v: number) => {
    const s = (Math.round(v * 10) / 10).toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (int < 1_000_000) return `${scaled(int / 1e3)}k`;
  if (int < 1_000_000_000) return `${scaled(int / 1e6)}M`;
  return `${scaled(int / 1e9)}B`;
}

export const CLUSTER_RADIUS_MIN = 4;
export const CLUSTER_RADIUS_MAX = 30;

/**
 * Sphere radius for a cluster node: logarithmic in the count, so the 33M-row
 * class stays on screen next to the 3-row class. Clamped to [MIN, MAX].
 */
export function clusterRadius(count: number): number {
  if (!Number.isFinite(count) || count < 0) throw new Error(`clusterRadius: bad count ${count}`);
  const r = CLUSTER_RADIUS_MIN + 2.5 * Math.log10(count + 1);
  return Math.min(CLUSTER_RADIUS_MAX, Math.max(CLUSTER_RADIUS_MIN, r));
}

/** Raised when an /api/aggregate payload violates the frozen contract shape. */
export class AggregateContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateContractError";
  }
}

/**
 * Validate + normalize an /api/aggregate response. Contract (card B4):
 * `nodes` is a list of <= 9 {group, type, count} rows with non-empty string
 * group/type and integer count >= 0. Returns a RE-SORTED copy (count
 * descending, group tie-break) so downstream never trusts the server's order.
 */
export function validateAggregate(response: AggregateResponse): AggregateNode[] {
  if (typeof response !== "object" || response === null) {
    throw new AggregateContractError("aggregate: response is not an object");
  }
  const nodes = (response as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) {
    throw new AggregateContractError("aggregate: `nodes` is not an array");
  }
  if (nodes.length > 9) {
    throw new AggregateContractError(`aggregate: expected <= 9 rows, got ${nodes.length}`);
  }
  const out: AggregateNode[] = [];
  for (const row of nodes) {
    if (typeof row !== "object" || row === null) {
      throw new AggregateContractError("aggregate: row is not an object");
    }
    const { group, type, count } = row as { group?: unknown; type?: unknown; count?: unknown };
    if (typeof group !== "string" || group === "") {
      throw new AggregateContractError("aggregate: row missing non-empty `group`");
    }
    if (typeof type !== "string" || type === "") {
      throw new AggregateContractError("aggregate: row missing non-empty `type`");
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new AggregateContractError(`aggregate: row ${type} has an invalid count`);
    }
    // The contract pins `type` to the NodeType union (a server violation is
    // a contract test failure); the shape check above is the runtime guard.
    out.push({ group, type: type as NodeType, count });
  }
  return out.sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

/** A cluster node: renderer node + the count that drives the 3D radius. */
export interface ClusterNode extends RendererNode {
  count: number;
}

/** Cluster-layer data: renderer graph whose nodes carry their count. */
export interface ClusterGraphData extends RendererGraph {
  nodes: ClusterNode[];
}

/**
 * The cluster layer as renderer data: one node per aggregate row plus a
 * deterministic RING of links so the force layout settles — fully isolated
 * nodes would drift apart under charge alone. Node ids carry the
 * CLUSTER_ID_PREFIX so click handlers can route them back to the store.
 *
 * The ring is cosmetic (the dataset has no inter-class edges to show); it
 * is purely a layout device and carries empty labels.
 */
export function clustersToGraphData(clusters: AggregateNode[]): ClusterGraphData {
  const nodes: ClusterNode[] = clusters.map((c) => ({
    id: clusterId(c.type),
    label: `${c.type} · ${formatCount(c.count)}`,
    group: c.group,
    color: getGroupColor(c.group),
    count: c.count,
  }));

  const links: RendererLink[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    links.push({
      id: `cluster-link-${i}`,
      source: nodes[i].id,
      target: nodes[i + 1].id,
      label: "",
      color: nodes[i].color ?? "gray",
    });
  }
  if (nodes.length > 2) {
    links.push({
      id: "cluster-link-close",
      source: nodes[nodes.length - 1].id,
      target: nodes[0].id,
      label: "",
      color: nodes[nodes.length - 1].color ?? "gray",
    });
  }
  return { nodes, links };
}

/**
 * Which mode the landing lands in for a given opened URL (card E3 S3):
 *
 * - "slice-restore": the URL carries a slice deep link (cursor and/or
 *   selection) — legacy C3 restore wins, the overview is not loaded.
 * - "ov-restore": the URL carries `ov=<type>` (a shared expanded cluster) —
 *   load the aggregate, then auto-expand that type.
 * - "overview": plain first paint — the aggregate overview is the landing.
 */
export type LandingMode = "slice-restore" | "ov-restore" | "overview";

export function pickLandingMode(view: {
  nextCursor: string | null;
  selectedId: string | null;
  ov: string | null;
}): LandingMode {
  if (view.nextCursor !== null || view.selectedId !== null) return "slice-restore";
  if (view.ov !== null) return "ov-restore";
  return "overview";
}
