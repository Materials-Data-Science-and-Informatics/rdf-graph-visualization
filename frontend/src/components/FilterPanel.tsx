import { Button } from "@/components/ui/button";
import * as React from "react";
import { getPaletteEntries } from "../config";
import type { NodeType } from "../api/types";

interface FilterPanelProps {
  /** Class the slice is currently filtered to (null = all classes). */
  value: NodeType | null;
  /** Pick a class (or null = all). The caller re-queries the slice. */
  onChange: (type: NodeType | null) => void;
  /** Disable every button (a slice load is in flight). */
  disabled?: boolean;
}

/**
 * Class filter panel (card E4): single-select over the data-model classes
 * from the runtime /api/config palette — the SAME module registry the
 * Legend and the node colours read from, so a swatch here always matches
 * the colour the graph renders that class in.
 *
 * Selecting a class is a SERVER-SIDE filter: the selection re-queries the
 * slice with `?type=<class>` (a fresh slice; the cursor chain resets), it
 * is not a client-side hide list. "All" clears the filter. The "Default"
 * (Unknown/fallback) group is deliberately not offered — the backend
 * rejects the fallback class as a filter value, so Unknown nodes only
 * appear in the unfiltered slice.
 */
const FilterPanel: React.FC<FilterPanelProps> = ({ value, onChange, disabled }) => {
  const renderButton = (type: NodeType | null, label: string, color?: string) => {
    const active = value === type;
    return (
      <Button
        key={type ?? "all"}
        type="button"
        size="sm"
        variant={active ? "default" : "outline"}
        aria-pressed={active}
        disabled={disabled}
        data-testid={type === null ? "filter-all" : `filter-${type}`}
        onClick={() => onChange(type)}
      >
        {color !== undefined && (
          <span aria-hidden className="size-3 rounded-[2px]" style={{ backgroundColor: color }} />
        )}
        <span className="capitalize">{label}</span>
      </Button>
    );
  };

  return (
    <div
      data-testid="filter-panel"
      role="group"
      aria-label="Filter slice by class"
      className="flex flex-wrap items-center gap-2"
    >
      {renderButton(null, "All")}
      {getPaletteEntries().map(({ group, type, color }) => renderButton(type, group, color))}
    </div>
  );
};

export default FilterPanel;
