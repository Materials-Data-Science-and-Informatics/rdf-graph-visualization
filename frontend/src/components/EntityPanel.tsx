import { AlertCircle, Check, Copy, ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { isHttpUrl, sortProperties } from "../lib/entity-view";
import { graphStore, useGraphStoreVersion } from "../store/use-graph-store";
import { entityLoader, useEntity } from "../store/use-entity";

interface EntityPanelProps {
  /** IRI of the selected node — the entity's persistent identifier (PURL). */
  iri: string;
  /** Called when the user closes the panel (clears the store selection). */
  onClose: () => void;
}

/**
 * Card E2 — entity detail panel. Opens for the selected node (rendered by
 * Content when the store has a selection) and shows the node's data-model
 * fields. The header (label/type/group/PURL) is available immediately from
 * the graph store; the property list is fetched from GET /api/entity/{iri}
 * (card B2) with loading / error / empty / populated states.
 *
 * Rendered as an absolutely-positioned drawer over the right edge of the
 * graph container, so opening/closing it never resizes or re-lays-out the
 * graph. Close: the X button, the Escape key, or selecting another node.
 */
const EntityPanel = ({ iri, onClose }: EntityPanelProps) => {
  const entity = useEntity(iri);
  // Immediate metadata from the store (shown before the fetch settles). The
  // selected node is always in the store (select() rejects unknown ids), but
  // degrade gracefully if it is not (e.g. a restored selection mid-load).
  const node = graphStore.getNode(iri);
  const [copied, setCopied] = useState(false);
  // Re-render when the graph store changes so the header (label/type/group)
  // tracks a label the expand-ingest refined on the selected node. The entity
  // fetch state is tracked separately by useEntity below.
  useGraphStoreVersion();

  // Close on Escape — self-contained (a window listener), no graph changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyPurl = useCallback(() => {
    navigator.clipboard?.writeText(iri).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [iri]);

  const purl = node?.purl ?? iri;
  const properties = entity.data ? sortProperties(entity.data.properties) : [];

  return (
    <aside
      role="complementary"
      aria-label="Entity details"
      data-testid="entity-panel"
      className="absolute inset-y-0 right-0 z-40 flex w-[22rem] max-w-[85vw] flex-col border-l border-border bg-card text-card-foreground shadow-lg"
    >
      <div className="flex items-start gap-2 border-b border-border p-4">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base leading-snug font-semibold">
            {node?.label || "Entity"}
          </h2>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {node?.type ?? "Unknown"}
            </span>
            {node && node.group && node.group !== node.type && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {node.group}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close panel" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <section>
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            PURL
          </h3>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 break-all text-sm" data-testid="entity-purl">
              {isHttpUrl(purl) ? (
                <a
                  href={purl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-start gap-1 text-primary underline-offset-4 hover:underline"
                >
                  <span className="break-all">{purl}</span>
                  <ExternalLink aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                </a>
              ) : (
                <span className="break-all">{purl}</span>
              )}
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label={copied ? "Copied" : "Copy PURL"}
              onClick={copyPurl}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            </Button>
          </div>
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Fields
          </h3>

          {entity.status === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Loading properties…
            </div>
          )}

          {entity.status === "error" && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950"
            >
              <AlertCircle
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
              />
              <div className="min-w-0 flex-1">
                <span className="font-semibold">Could not load entity</span>
                <span className="mt-0.5 block break-words" data-testid="entity-error">
                  {entity.error}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => entityLoader.load(iri)}
                >
                  Retry
                </Button>
              </div>
            </div>
          )}

          {entity.status === "ready" && properties.length === 0 && (
            <p className="text-sm text-muted-foreground">No properties.</p>
          )}

          {entity.status === "ready" && properties.length > 0 && (
            <dl className="space-y-3">
              {properties.map((row) => (
                <div key={row.predicate}>
                  <dt
                    className="text-sm font-medium"
                    title={row.predicate}
                    data-testid="entity-field"
                  >
                    {row.name}
                  </dt>
                  <dd className="mt-0.5">
                    {row.values.map((value, i) => (
                      <div
                        key={`${row.predicate}-${i}`}
                        className="break-words text-sm text-muted-foreground"
                      >
                        {isHttpUrl(value) ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-primary underline-offset-4 hover:underline"
                          >
                            {value}
                          </a>
                        ) : (
                          <span className="break-words">{value}</span>
                        )}
                      </div>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
};

export default EntityPanel;
