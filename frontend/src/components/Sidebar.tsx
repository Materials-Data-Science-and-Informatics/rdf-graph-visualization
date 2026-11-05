import { memo, useEffect, useState, type ReactNode } from "react";
import { PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NODE_LIMIT_DEFAULT, countToSlider, sliderToCount } from "@/engine/layout-utils";
import { DEPTH_DEFAULT, DEPTH_MAX, DEPTH_MIN, clampDepth } from "@/lib/sidebar-settings";
import { statusText, type StreamStatus } from "@/lib/use-graph-stream";
import type { NodeInfo } from "@/lib/api";
import { CopyButton, Row, Swatch, type LegendRow } from "./shared";

export interface SidebarProps {
  open: boolean;
  onToggle: () => void;
  rootIri: string;
  root: NodeInfo | null;
  rootColor: string;
  nodeLimit: number;
  onNodeLimit: (n: number) => void; // receives a node count
  depth: number;
  onDepth: (d: number) => void;
  status: StreamStatus;
  shown: number;
  fps: number;
  settling: boolean;
  legend: LegendRow[];
  onGroupVisible: (index: number, visible: boolean) => void;
  dim: 2 | 3;
  onDim: (d: 2 | 3) => void;
  edgeOpacity: number;
  onEdgeOpacity: (v: number) => void;
  arrows: boolean;
  onArrows: (v: boolean) => void;
  onResetView: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b px-4 py-3">
      <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

const Switch = ({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) => (
  <label
    className={cn("flex items-center justify-between gap-2 text-sm", disabled && "opacity-50")}
  >
    <span>
      {label}
      {hint && <span className="text-muted-foreground ml-1 text-xs">({hint})</span>}
    </span>
    <input
      type="checkbox"
      role="switch"
      className="accent-primary size-4"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  </label>
);

function Sidebar(p: SidebarProps) {
  const s = p.status;
  const { depth, onDepth } = p;
  const [draft, setDraft] = useState(String(depth));
  useEffect(() => setDraft(String(depth)), [depth]);
  const commitDepth = () => {
    const v = clampDepth(draft === "" ? depth : Number(draft));
    setDraft(String(v));
    if (v !== depth) onDepth(v);
  };
  const phase =
    s.phase === "streaming"
      ? `streaming hop ${s.hop}`
      : s.phase === "error"
        ? `error: ${s.error ?? "stream failed"}`
        : s.phase === "done"
          ? `done (${s.doneReason ?? "done"})`
          : "ready";
  return (
    <>
      {p.open && (
        <button
          type="button"
          aria-label="Close sidebar"
          tabIndex={-1}
          className="absolute inset-0 z-10 bg-black/40 md:hidden"
          onClick={p.onToggle}
        />
      )}
      <aside
        id="sidebar"
        aria-label="Graph controls"
        className={cn(
          "bg-background z-20 flex w-[300px] shrink-0 flex-col overflow-y-auto border-r",
          "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-lg",
          !p.open && "hidden"
        )}
      >
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="text-sm font-semibold">Controls</span>
          <Button variant="ghost" size="icon" aria-label="Collapse sidebar" onClick={p.onToggle}>
            <PanelLeftClose />
          </Button>
        </div>

        <Section title="Root">
          <div className="flex items-center gap-2">
            <Swatch color={p.rootColor} />
            <span className="min-w-0 text-sm font-medium break-words">
              {p.root?.label ?? "(unlabelled)"}
            </span>
          </div>
          {p.root?.group && <div className="text-muted-foreground text-xs">{p.root.group}</div>}
          <div className="flex items-center gap-1">
            <code
              className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
              title={p.rootIri}
            >
              {p.rootIri}
            </code>
            <CopyButton text={p.rootIri} />
          </div>
        </Section>

        <Section title="Inputs">
          <label className="block space-y-1 text-sm">
            <span className="flex justify-between">
              Node count
              <span className="tabular-nums">{p.nodeLimit.toLocaleString()}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={countToSlider(p.nodeLimit)}
              aria-label="Number of nodes shown"
              className="accent-primary w-full"
              onChange={(e) => p.onNodeLimit(sliderToCount(Number(e.target.value)))}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>
              Depth <span className="text-muted-foreground text-xs">(hops, reloads)</span>
            </span>
            <input
              type="number"
              min={DEPTH_MIN}
              max={DEPTH_MAX}
              step={1}
              value={draft}
              aria-label="Maximum hops from the root"
              className="bg-background w-16 rounded-md border px-2 py-1 text-right text-sm tabular-nums"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDepth}
              onKeyDown={(e) => e.key === "Enter" && commitDepth()}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              p.onNodeLimit(NODE_LIMIT_DEFAULT);
              onDepth(DEPTH_DEFAULT);
            }}
          >
            Reset to defaults
          </Button>
        </Section>

        <Section title="Status">
          <div className="text-xs break-words">{statusText(s)}</div>
          <Row label="Phase" value={phase} />
          <Row
            label="Loaded"
            value={`${s.nodes.toLocaleString()} nodes, ${s.edges.toLocaleString()} edges`}
          />
          <Row label="Shown nodes" value={p.shown.toLocaleString()} />
          <Row
            label="Layout"
            value={p.fps ? `${p.settling ? "settling" : "idle"} · ${Math.round(p.fps)} fps` : "-"}
          />
          {s.cached && (
            <Row
              label="Cached snapshot"
              value={s.builtAt ? new Date(s.builtAt).toLocaleString() : "yes"}
            />
          )}
        </Section>

        <Section title="Legend & filter">
          <ul className="space-y-1">
            {p.legend.map((g, i) => (
              <li key={g.name}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary size-4"
                    checked={g.visible}
                    aria-label={`Show ${g.name}`}
                    onChange={(e) =>
                      p.onGroupVisible(i === p.legend.length - 1 ? -1 : i, e.target.checked)
                    }
                  />
                  <Swatch color={g.color} />
                  <span className={cn("flex-1 truncate", !g.visible && "text-muted-foreground")}>
                    {g.name}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {g.count.toLocaleString()}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Settings">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span id="dim-label">Dimensions</span>
            <div role="group" aria-labelledby="dim-label" className="flex gap-1">
              {([2, 3] as const).map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={p.dim === d ? "default" : "outline"}
                  aria-pressed={p.dim === d}
                  onClick={() => p.onDim(d)}
                >
                  {d}D
                </Button>
              ))}
            </div>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="flex justify-between">
              Edge opacity
              <span className="tabular-nums">{Math.round(p.edgeOpacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={2}
              step={0.05}
              value={p.edgeOpacity}
              className="accent-primary w-full"
              onChange={(e) => p.onEdgeOpacity(Number(e.target.value))}
            />
          </label>
          <Switch label="Arrows" checked={p.arrows} onChange={p.onArrows} />
          <Switch
            label="Curved edges"
            checked={false}
            onChange={() => undefined}
            disabled
            hint="coming next"
          />
          <Button variant="outline" size="sm" className="w-full" onClick={p.onResetView}>
            Reset view
          </Button>
        </Section>

        <p className="text-muted-foreground px-4 py-3 text-xs">
          Left-click: details &middot; Right-click: make root &middot; Drag: rotate &middot; Scroll:
          zoom
        </p>
      </aside>
    </>
  );
}

export default memo(Sidebar);
