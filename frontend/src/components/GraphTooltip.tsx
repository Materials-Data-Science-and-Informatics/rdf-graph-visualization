import { forwardRef, memo } from "react";
import type { PickHit } from "@/engine/picking";
import type { GraphStore } from "@/lib/graph-store";
import { formatRelationRow, summarizeRelations } from "@/lib/node-summary";

const NO_GROUP_COLOR = "#8a8f98";

/** Label or IRI of a store node. */
const nodeTitle = (store: GraphStore, i: number): string =>
  store.labels[i] ?? store.nodeIds[i] ?? "(unknown)";

/** Hover card near the cursor (DOM, theme tokens); positioned by the parent via `style.transform`. */
const GraphTooltip = forwardRef<HTMLDivElement, { store: GraphStore; hit: PickHit }>(
  function GraphTooltip({ store, hit }, ref) {
    let body = null;
    if (hit.kind === "node" && hit.index < store.nodeCount) {
      const g = store.groups[hit.index];
      const color = g >= 0 ? store.groupColors[g] : NO_GROUP_COLOR;
      const { rows, more } = summarizeRelations(store.relationsOf(hit.index));
      body = (
        <>
          <div className="font-medium break-words">{nodeTitle(store, hit.index)}</div>
          <div className="text-muted-foreground flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full border"
              style={{ background: color }}
            />
            {g >= 0 ? store.groupNames[g] : "Unclassified"}
          </div>
          {store.labels[hit.index] && (
            <div className="text-muted-foreground truncate text-[10px]">
              {store.nodeIds[hit.index]}
            </div>
          )}
          {rows.length > 0 && (
            <ul className="mt-1 space-y-0.5 tabular-nums">
              {rows.map((r) => (
                <li key={`${r.dir}-${r.predicate}`}>{formatRelationRow(r)}</li>
              ))}
              {more > 0 && <li className="text-muted-foreground">{"…"}</li>}
            </ul>
          )}
        </>
      );
    } else if (hit.kind === "edge" && hit.src !== undefined && hit.dst !== undefined) {
      const p = hit.storeEdge !== undefined ? store.edgePredicate[hit.storeEdge] : undefined;
      const pred = p !== undefined ? (store.predicates[p] ?? "") : "";
      const short = p !== undefined ? (store.predicateShort[p] ?? pred) : "";
      body = (
        <>
          <div className="font-medium">{short || "(relation)"}</div>
          {pred && <div className="text-muted-foreground truncate text-[10px]">{pred}</div>}
          <div className="break-words">
            {nodeTitle(store, hit.src)} {"→"} {nodeTitle(store, hit.dst)}
          </div>
        </>
      );
    }
    if (!body) return null;
    return (
      <div
        ref={ref}
        role="tooltip"
        className="bg-popover text-popover-foreground pointer-events-none absolute top-0 left-0 z-30 max-w-xs space-y-0.5 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
        style={{ transform: "translate(-9999px, -9999px)" }}
      >
        {body}
      </div>
    );
  }
);

export default memo(GraphTooltip);
