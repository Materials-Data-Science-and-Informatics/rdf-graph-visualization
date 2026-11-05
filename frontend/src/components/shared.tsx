import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/use-copy";

export interface LegendRow {
  name: string;
  color: string;
  count: number;
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const { done, copy } = useCopy();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label="Copy IRI"
      onClick={() => copy(text)}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/** HKG category icons (from the unhide UI) per data-model class; white masks tinted with the class colour. */
const CLASS_ICONS: Record<string, string> = {
  Person: "Person",
  Institution: "institutions",
  Dataset: "datasets",
  Document: "documents",
  Software: "software",
  Instrument: "instruments",
  Project: "projects",
  Event: "trainings",
};

/** Class colour marker: the HKG category icon in that colour when `name` has one, else a dot. */
export function Swatch({ color, name }: { color: string; name?: string | null }) {
  const icon = name ? CLASS_ICONS[name] : undefined;
  if (icon) {
    const mask = `url(/branding/category/${icon}.png) center / contain no-repeat`;
    return (
      <span
        aria-hidden
        className="inline-block size-4 shrink-0"
        style={{ background: color, mask, WebkitMask: mask }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-full border"
      style={{ background: color }}
    />
  );
}
