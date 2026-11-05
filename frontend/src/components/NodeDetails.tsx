import { ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NodeInfo } from "@/lib/api";
import { sortRelationCounts } from "@/lib/node-summary";
import { CopyButton, Swatch, type LegendRow } from "./shared";

export interface SelectedView {
  iri: string;
  status: "loading" | "ok" | "none" | "error";
  info?: NodeInfo;
  error?: string;
}

interface Props {
  sel: SelectedView;
  legend: LegendRow[];
  isRoot: boolean;
  onClose: () => void;
  onMakeRoot: () => void;
}

const localName = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("#")) + 1) || p;

/** Floating details card (right side of the canvas; bottom sheet on narrow screens). */
export default function NodeDetails({ sel, legend, isRoot, onClose, onMakeRoot }: Props) {
  const { info } = sel;
  const color = legend.find((l) => l.name === info?.group)?.color;
  const rels = info ? sortRelationCounts(info.relations) : [];

  return (
    <aside
      role="complementary"
      aria-label="Selected node details"
      tabIndex={-1}
      className="bg-card text-card-foreground absolute z-10 flex flex-col overflow-hidden border shadow-lg max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[55%] max-md:rounded-t-xl md:top-14 md:right-3 md:max-h-[calc(100%-4.5rem)] md:w-[340px] md:rounded-xl"
    >
      <div className="flex items-start gap-2 border-b px-3 py-2">
        {color && <Swatch color={color} />}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium break-words">
            {sel.status === "ok" && info ? (info.label ?? "(unlabelled)") : "Selected node"}
          </h2>
          {info?.group && <div className="text-muted-foreground text-xs">{info.group}</div>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Close details"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2"
        aria-busy={sel.status === "loading"}
      >
        {sel.status === "loading" && (
          <p className="text-muted-foreground text-sm">Loading details...</p>
        )}
        {sel.status === "none" && <p className="text-muted-foreground text-sm">No details</p>}
        {(sel.status === "error" || (sel.status === "ok" && !info)) && (
          <p role="alert" className="text-destructive text-sm break-words">
            Could not load details: {sel.error ?? "unknown error"}
          </p>
        )}
        <div className="flex items-center gap-1">
          <code className="text-muted-foreground min-w-0 flex-1 truncate text-xs" title={sel.iri}>
            {sel.iri}
          </code>
          <CopyButton text={sel.iri} />
        </div>
        <div className="flex gap-2">
          {/^https?:\/\//i.test(sel.iri) && (
            <Button variant="outline" size="sm" asChild>
              <a href={sel.iri} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Open
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={isRoot}
            title={isRoot ? "Already the root" : undefined}
            onClick={onMakeRoot}
          >
            Make root
          </Button>
        </div>
        {info && info.types.length > 0 && (
          <ul className="text-muted-foreground space-y-0.5 text-xs">
            {info.types.map((t) => (
              <li key={t} className="truncate" title={t}>
                {t}
              </li>
            ))}
          </ul>
        )}
        {rels.length > 0 && (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground text-left">
              <tr>
                <th className="font-normal">Relation</th>
                <th className="text-right font-normal">out</th>
                <th className="text-right font-normal">in</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rels.map((r) => (
                <tr key={r.predicate}>
                  <td className="max-w-0 truncate pr-2" title={r.predicate}>
                    {localName(r.predicate)}
                  </td>
                  <td className="text-right">{r.out.toLocaleString()}</td>
                  <td className="text-right">{r.in.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}
