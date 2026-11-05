import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Search } from "lucide-react";
import { searchEntities, type GraphGroupConfig, type SearchResult } from "@/lib/api";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MAX_QUERY_LEN,
  SEARCH_MAX_RESULTS,
  SEARCH_MIN_CHARS,
  debounce,
  groupForResult,
  shortIri,
  wrapIndex,
} from "@/lib/search";
import { cn } from "@/lib/utils";
import { Swatch } from "./shared";

/** What the search box needs from the graph view. */
export interface GraphControl {
  /** Node is in the graph and inside the shown node window. */
  has(iri: string): boolean;
  /** In graph: select + fly to it. Otherwise make it the root and select it once it appears. */
  open(iri: string): void;
  makeRoot(iri: string): void;
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; results: SearchResult[] };

export default function SearchBox({
  groups,
  control,
}: {
  groups: GraphGroupConfig[];
  control: React.RefObject<GraphControl | null>;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);

  const run = useRef(
    debounce((q: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState({ status: "loading" });
      searchEntities(q, ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setState({ status: "ok", results: r.slice(0, SEARCH_MAX_RESULTS) });
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
        });
    }, SEARCH_DEBOUNCE_MS)
  ).current;

  useEffect(
    () => () => {
      run.cancel();
      abortRef.current?.abort();
    },
    [run]
  );

  // "/" focuses the search box unless the user is typing somewhere
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onChange = (value: string) => {
    setText(value);
    setActive(-1);
    abortRef.current?.abort(); // stale in-flight results must not replace "loading"
    const q = value.trim();
    if (q.length < SEARCH_MIN_CHARS) {
      run.cancel();
      abortRef.current?.abort();
      setState({ status: "idle" });
      return;
    }
    setOpen(true);
    setState({ status: "loading" });
    run(q);
  };

  const results = state.status === "ok" ? state.results : [];
  const q = text.trim();
  const showPanel = open && q.length >= SEARCH_MIN_CHARS;

  const choose = useCallback(
    (r: SearchResult, root: boolean) => {
      const c = control.current;
      if (!c) return;
      if (root) c.makeRoot(r.id);
      else c.open(r.id);
      setOpen(false);
      inputRef.current?.blur();
    },
    [control]
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => wrapIndex(a, e.key === "ArrowDown" ? 1 : -1, results.length));
    } else if (e.key === "Enter") {
      const r = results[active >= 0 ? active : 0];
      if (!r || !showPanel) return;
      e.preventDefault();
      choose(r, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (showPanel) setOpen(false);
      else {
        onChange("");
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div
      className="group relative w-full max-w-xs transition-[max-width] focus-within:max-w-md max-sm:max-w-[9rem] max-sm:focus-within:max-w-full"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <Search
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search entities"
        aria-expanded={showPanel}
        aria-controls={showPanel ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && active >= 0 ? `${uid}-opt-${active}` : undefined}
        autoComplete="off"
        maxLength={SEARCH_MAX_QUERY_LEN}
        spellCheck={false}
        placeholder="Search entities  ( / )"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 h-8 w-full rounded-md border pr-7 pl-7 text-sm outline-none focus-visible:ring-[3px]"
      />
      {state.status === "loading" && showPanel && (
        <Loader2
          aria-hidden
          className="text-muted-foreground absolute top-1/2 right-2 size-3.5 -translate-y-1/2 animate-spin"
        />
      )}
      {showPanel && (
        <div className="bg-popover text-popover-foreground absolute top-full right-0 left-0 z-50 mt-1 max-h-96 overflow-auto rounded-md border p-1 shadow-md max-sm:fixed max-sm:inset-x-2 max-sm:top-12">
          <ul id={listId} role="listbox" aria-label="Search results" className="m-0 list-none p-0">
            {results.map((r, i) => {
              const g = groupForResult(r, groups);
              const inGraph = control.current?.has(r.id) ?? false;
              return (
                <li
                  key={r.id}
                  role="presentation"
                  className={cn(
                    "flex items-center gap-2 rounded pr-2",
                    i === active && "bg-accent text-accent-foreground"
                  )}
                >
                  <div
                    id={`${uid}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-sm"
                    onMouseMove={() => active !== i && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(r, false)}
                  >
                    <Swatch color={g?.color ?? "#8a8f98"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{r.label}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {g?.name ?? "Unclassified"} · {shortIri(r.id)}
                      </span>
                    </span>
                    {!inGraph && (
                      <span className="text-muted-foreground shrink-0 text-xs">New root</span>
                    )}
                  </div>
                  {inGraph && (
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      className="text-muted-foreground hover:bg-background hover:text-foreground shrink-0 rounded border px-1.5 py-0.5 text-xs"
                      onClick={() => choose(r, true)}
                    >
                      Make root
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {results.length > 0 && (
            <p className="text-muted-foreground border-t px-2 pt-1.5 pb-0.5 text-xs">
              Enter: focus · Shift+Enter: make root · Esc: close
            </p>
          )}
          {state.status === "error" && (
            <p role="alert" className="text-destructive px-2 py-1.5 text-xs">
              Search failed: {state.message}
            </p>
          )}
          {state.status === "loading" && (
            <p role="status" className="text-muted-foreground px-2 py-1.5 text-xs">
              Searching…
            </p>
          )}
          {state.status === "ok" && results.length === 0 && (
            <p role="status" className="text-muted-foreground px-2 py-1.5 text-xs">
              No matches for “{q}”
            </p>
          )}
        </div>
      )}
    </div>
  );
}
