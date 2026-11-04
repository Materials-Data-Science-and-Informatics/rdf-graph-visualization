import * as React from "react";
import { FALLBACK_COLOR, getPaletteEntries } from "../config";

/**
 * Palette legend (card C4): entries come from the runtime /api/config
 * palette (module registry), not a build-time YAML import. The trailing
 * "Default" row is the code-side fallback colour for groups absent from the
 * config (e.g. "Unknown").
 */
const Legend: React.FC = () => {
  const row = "mb-[5px] flex items-center";
  const swatch = "mr-2 size-3";
  return (
    <div className="absolute top-[10px] right-[10px] rounded-[8px] bg-white p-[10px] shadow-md">
      {getPaletteEntries().map(({ group, color }) => (
        <div key={group} className={row}>
          <span className={swatch} style={{ backgroundColor: color }} />
          <span className="text-sm capitalize">{group}</span>
        </div>
      ))}
      <div className={row}>
        <span className={swatch} style={{ backgroundColor: FALLBACK_COLOR }} />
        <span className="text-sm capitalize">Default</span>
      </div>
    </div>
  );
};

export default Legend;
