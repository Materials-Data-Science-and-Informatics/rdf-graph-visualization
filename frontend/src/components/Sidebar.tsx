import { memo, useEffect, useState, type ReactNode } from "react";
import { PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NODE_LIMIT_DEFAULT, countToSlider, sliderToCount } from "@/engine/layout-utils";
import {
  DEPTH_DEFAULT,
  DEPTH_MAX,
  DEPTH_MIN,
  FANOUT_DEFAULT,
  FANOUT_MAX,
  FANOUT_MIN,
  clampDepth,
  clampFanout,
} from "@/lib/sidebar-settings";
import { statusText, type StreamStatus } from "@/lib/use-graph-stream";
import type { NodeInfo } from "@/lib/api";
import { ROOT_PRESETS, findPreset } from "@/lib/centers";
import { DEFAULT_ROOT_IRI } from "@/lib/config";
import { CopyButton, Row, Swatch, type LegendRow } from "./shared";

export interface SidebarProps {
  open: boolean;
  onToggle: () => void;
  rootIri: string;
  onRoot: (iri: string) => void;
  root: NodeInfo | null;
  rootColor: string;
  nodeLimit: number;
  onNodeLimit: (n: number) => void; // receives a node count
  depth: number;
  onDepth: (d: number) => void;
  fanout: number;
  onFanout: (n: number) => void;
  status: StreamStatus;
  shown: number;
  fps: number;
  settling: boolean;
  legend: LegendRow[];
  relationLegend: LegendRow[];
  dim: 2 | 3;
  onDim: (d: 2 | 3) => void;
  edgeOpacity: number;
  onEdgeOpacity: (v: number) => void;
  arrows: boolean;
  onArrows: (v: boolean) => void;
  curved: boolean;
  onCurved: (v: boolean) => void;
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

/** Favicon of a root preset; hidden when it fails to load (external host). */
function PresetIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      className="size-4 shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/** Number field that commits (clamped) on blur / Enter, so typing does not restart the stream. */
function CommitNumber({
  label,
  hint,
  ariaLabel,
  value,
  min,
  max,
  clamp,
  onCommit,
}: {
  label: string;
  hint: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  clamp: (v: number) => number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = clamp(draft === "" ? value : Number(draft));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span>
        {label} <span className="text-muted-foreground text-xs">({hint})</span>
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        className="bg-background w-20 rounded-md border px-2 py-1 text-right text-sm tabular-nums"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

/** Compact legend block: only rows with a non-zero count. */
function LegendList({ title, rows }: { title: string; rows: LegendRow[] }) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">none shown</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.name} className="flex items-center gap-2 text-sm">
              <Swatch color={r.color} />
              <span className="flex-1 truncate" title={r.name}>
                {r.name}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {r.count.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Sidebar(p: SidebarProps) {
  const s = p.status;
  const preset = findPreset(p.rootIri);
  const { onDepth } = p;
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
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Root organisation</span>
            {preset && <PresetIcon src={preset.favicon} />}
            <select
              value={p.rootIri}
              aria-label="Root organisation"
              className="bg-background min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
              onChange={(e) => p.onRoot(e.target.value)}
            >
              {!preset && <option value={p.rootIri}>Other: {p.root?.label ?? p.rootIri}</option>}
              {ROOT_PRESETS.map((c) => (
                <option key={c.iri} value={c.iri} title={c.name}>
                  {c.short === c.name ? c.name : `${c.short} – ${c.name}`}
                </option>
              ))}
            </select>
          </label>
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
          <CommitNumber
            label="Depth"
            hint="hops, reloads"
            ariaLabel="Maximum hops from the root"
            value={p.depth}
            min={DEPTH_MIN}
            max={DEPTH_MAX}
            clamp={clampDepth}
            onCommit={onDepth}
          />
          <CommitNumber
            label="Neighbours per node"
            hint="0 = all, reloads"
            ariaLabel="Maximum new neighbours taken per node and hop"
            value={p.fanout}
            min={FANOUT_MIN}
            max={FANOUT_MAX}
            clamp={clampFanout}
            onCommit={p.onFanout}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              p.onNodeLimit(NODE_LIMIT_DEFAULT);
              onDepth(DEPTH_DEFAULT);
              p.onFanout(FANOUT_DEFAULT);
              p.onRoot(DEFAULT_ROOT_IRI);
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
          <Switch label="Curved edges" checked={p.curved} onChange={p.onCurved} />
          <Button variant="outline" size="sm" className="w-full" onClick={p.onResetView}>
            Reset view
          </Button>
        </Section>

        <p className="text-muted-foreground border-b px-4 py-3 text-xs">
          Left-click: details &middot; Right-click: make root &middot; Drag: rotate &middot; Scroll:
          zoom
        </p>

        <Section title="Legend">
          <LegendList title="Nodes" rows={p.legend.filter((r) => r.count > 0)} />
          <LegendList title="Relations" rows={p.relationLegend} />
        </Section>
      </aside>
    </>
  );
}

export default memo(Sidebar);
