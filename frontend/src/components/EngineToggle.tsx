// Card D4 — the renderer (engine) toggle.
//
// A segment of the registered engines; selecting one runs the D4 switch in
// use-graph-renderer (carry positions P5/P7, replay focus, dispose the
// outgoing renderer). The active engine is marked with aria-pressed; the
// data-testid values are the E6 smoke hooks.

import { Button } from "@/components/ui/button";
import * as React from "react";

interface EngineToggleProps {
  /** Registered engine ids, in registration order. */
  engines: string[];
  /** The active engine id. */
  activeId: string;
  /** Switch to the given engine (the hook no-ops unknown/active ids). */
  onSelect: (id: string) => void;
}

const ENGINE_LABELS: Record<string, string> = {
  sigma: "sigma 2D",
  cosmos: "cosmos 2D",
  cosmos3d: "cosmos 3D",
};

const EngineToggle: React.FC<EngineToggleProps> = ({ engines, activeId, onSelect }) => {
  if (engines.length < 2) return null;
  return (
    <div
      className="absolute left-[10px] top-[170px] flex items-center gap-[6px] p-[10px]"
      role="radiogroup"
      aria-label="Graph engine"
      data-testid="engine-toggle"
    >
      {engines.map((id) => (
        <Button
          key={id}
          variant={id === activeId ? "default" : "outline"}
          size="sm"
          aria-pressed={id === activeId}
          aria-label={`Switch to ${ENGINE_LABELS[id] ?? id} renderer`}
          data-testid={`engine-toggle-${id}`}
          onClick={() => onSelect(id)}
        >
          {ENGINE_LABELS[id] ?? id}
        </Button>
      ))}
    </div>
  );
};

export default EngineToggle;
