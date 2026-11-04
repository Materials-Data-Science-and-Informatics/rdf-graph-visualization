// Card E1 — autocomplete search → fly-to.
//
// A combobox in the navbar: debounced (200 ms) prefix queries against
// GET /api/search (card B5, capped at 20 results server-side), with a
// keyboard-navigable suggestion list. Picking a hit calls focusEntity()
// (card C2 store + card B2 /api/expand for out-of-slice entities), which
// bumps the monotonic focus token the Graph component's fly-to effect
// consumes — the camera jump starts in the same tick for in-slice hits,
// and right after the ~50 ms expand merge for out-of-slice ones.
//
// The query state machine lives in lib/search-suggest.ts (pure, headless-
// tested); this file is the thin React binding (useSyncExternalStore) plus
// the ARIA combobox wiring.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Search } from "lucide-react";
import { searchEntities } from "../api/client";
import type { SearchResult } from "../api/types";
import { cn } from "../lib/utils";
import { SearchSuggest } from "../lib/search-suggest";
import { focusEntity } from "../store/use-graph-store";

const LISTBOX_ID = "search-listbox";
const optionId = (index: number): string => `search-option-${index}`;

export const SEARCH_DEBOUNCE_MS = 200;
export const SEARCH_MIN_CHARS = 2;
/** Mirrors the backend bound: q is 1..200 chars (422 above). */
export const SEARCH_MAX_CHARS = 200;

export const SearchBox = () => {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickAbortRef = useRef<AbortController | null>(null);

  const suggest = useMemo(
    () =>
      new SearchSuggest({
        fetchSuggest: async (query, signal) => {
          const response = await searchEntities(query, { signal });
          return response.results;
        },
        delayMs: SEARCH_DEBOUNCE_MS,
        minChars: SEARCH_MIN_CHARS,
        maxChars: SEARCH_MAX_CHARS,
      }),
    []
  );
  const snap = useSyncExternalStore(suggest.subscribe, suggest.getSnapshot, suggest.getSnapshot);

  // Abort in-flight pick + dispose the suggest state machine on unmount.
  useEffect(
    () => () => {
      pickAbortRef.current?.abort();
      suggest.dispose();
    },
    [suggest]
  );

  const results = snap.results;
  const open = focused && snap.status !== "idle" && text.trim().length >= SEARCH_MIN_CHARS;

  const handleText = useCallback(
    (value: string) => {
      setText(value);
      setPickError(null);
      setActiveIndex(-1);
      suggest.setText(value);
    },
    [suggest]
  );

  const close = useCallback(() => setFocused(false), []);

  const pick = useCallback(
    (result: SearchResult) => {
      close();
      inputRef.current?.focus({ preventScroll: true });
      setText(result.label || result.id);
      // Reset the suggest state to idle — without this, refocusing the input
      // would re-open the list on the stale (pre-pick) results.
      suggest.setText("");
      setActiveIndex(-1);
      setPickError(null);
      setPicking(true);
      pickAbortRef.current?.abort();
      const controller = new AbortController();
      pickAbortRef.current = controller;
      void (async () => {
        try {
          await focusEntity(result.id, controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          setPickError(err instanceof Error ? err.message : String(err));
        } finally {
          if (pickAbortRef.current === controller) setPicking(false);
        }
      })();
    },
    [close, suggest]
  );

  const pickActive = useCallback(() => {
    if (!open || results.length === 0) return;
    pick(results[activeIndex >= 0 ? activeIndex : 0]);
  }, [open, results, activeIndex, pick]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (results.length > 0) {
            setFocused(true);
            setActiveIndex((i) => (i + 1) % results.length);
          }
          break;
        case "ArrowUp":
          event.preventDefault();
          if (results.length > 0) {
            setFocused(true);
            setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
          }
          break;
        case "Enter":
          if (open && results.length > 0) {
            event.preventDefault();
            pickActive();
          }
          break;
        case "Escape":
          if (open) {
            event.preventDefault();
            close();
          }
          break;
        case "Tab":
          close();
          break;
        default:
          break;
      }
    },
    [open, results.length, pickActive, close]
  );

  const spinner = snap.status === "loading" || picking;

  return (
    <div className="relative w-full max-w-md lg:w-72">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-neutral-500"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? LISTBOX_ID : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-label="Search entities"
          placeholder="Search entities…"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => handleText(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={close}
          className="h-9 w-full rounded-md border border-white/60 bg-white pl-8 pr-8 text-sm text-neutral-900 shadow-sm outline-none placeholder:text-neutral-500 focus:ring-2 focus:ring-white"
        />
        {spinner && (
          <Loader2
            aria-hidden
            className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-neutral-500"
          />
        )}
      </div>

      {open && (
        <ul
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-md border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-neutral-900"
        >
          {snap.status === "error" && (
            <li
              role="option"
              aria-selected={false}
              aria-disabled="true"
              className="px-3 py-2 text-sm text-red-600 dark:text-red-400"
            >
              {snap.error}
            </li>
          )}
          {snap.status === "done" && results.length === 0 && (
            <li
              role="option"
              aria-selected={false}
              aria-disabled="true"
              className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400"
            >
              No matches for “{snap.query}”
            </li>
          )}
          {snap.status === "done" &&
            results.map((result, index) => (
              <li
                key={result.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                // mousedown fires before blur: keep focus on the input so the
                // click can complete (a plain click would close the list first).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(result)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                  index === activeIndex
                    ? "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100"
                    : "text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
                )}
              >
                <span className="truncate">{result.label || result.id}</span>
                <span className="ml-auto shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                  {result.type}
                </span>
              </li>
            ))}
        </ul>
      )}

      {pickError && (
        <p
          role="alert"
          className="absolute z-50 mt-1 w-full rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-lg dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {pickError}
        </p>
      )}
    </div>
  );
};

export default SearchBox;
