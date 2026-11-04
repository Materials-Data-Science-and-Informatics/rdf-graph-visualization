// Card E1 — debounced autocomplete suggestions for GET /api/search.
//
// A plain observable class (subscribe/getSnapshot — the card C2 store
// pattern), so the React wrapper (SearchBox) binds it with
// useSyncExternalStore and the test harness drives it headless with an
// injected clock and an injected fetch — no React, no DOM.
//
// States (snapshot.status):
//   idle    no query in flight, nothing to show (no text / below minChars)
//   loading debounced query in flight
//   done    results for `query` (possibly empty — the UI shows "no matches")
//   error   the last query failed (or the text exceeds the 200-char bound);
//           the message is kept until the next query
//
// Stale-result safety: every setText() bumps an internal sequence token and
// aborts the in-flight fetch. A resolution for a superseded token is
// dropped — the dropdown can never show results for a query the user has
// already typed past.

import type { SearchResult } from "../api/types";

export type SuggestStatus = "idle" | "loading" | "done" | "error";

export interface SuggestSnapshot {
  /** The text the current `results`/`error` describe ("" when idle). */
  query: string;
  status: SuggestStatus;
  results: SearchResult[];
  error: string | null;
}

export interface SuggestOptions {
  /** Performs the /api/search fetch; receives the query and an abort signal. */
  fetchSuggest: (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
  /** Debounce after the last keystroke (ms). Default 200. */
  delayMs?: number;
  /** Text shorter than this never queries (single-char prefixes are noise).
   *  Default 2. */
  minChars?: number;
  /** The backend rejects q longer than 200 chars with 422; instead of
   *  firing a doomed request, that shows as an error state. Default 200. */
  maxChars?: number;
  /** Injectable clock (tests); defaults to the globals. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class SearchSuggest {
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  private snapshot: SuggestSnapshot = { query: "", status: "idle", results: [], error: null };
  private readonly listeners: Set<() => void> = new Set();
  private seq = 0;
  private timer: unknown = null;
  private controller: AbortController | null = null;

  constructor(private readonly options: SuggestOptions) {
    this.setT = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = options.clearTimeout ?? ((handle) => clearTimeout(handle as number | undefined));
  }

  // ---------------------------------------------------------------- observers

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Stable-reference snapshot for useSyncExternalStore: the object only
   * changes identity when a commit() happens, so React's Object.is check is
   * both correct and cheap.
   */
  getSnapshot = (): SuggestSnapshot => this.snapshot;

  private commit(patch: Partial<SuggestSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // -------------------------------------------------------------------- text

  /**
   * Feed the latest input text. Cancels any pending debounce and aborts any
   * in-flight fetch; schedules a new query delayMs after this call — unless
   * the text is out of bounds (too short → idle, too long → error, no
   * request in either case).
   */
  setText(text: string): void {
    this.cancelPending();
    this.seq += 1; // invalidate whatever is in flight / late
    const query = text.trim();
    const minChars = this.options.minChars ?? 2;
    const maxChars = this.options.maxChars ?? 200;
    if (query.length < minChars) {
      this.commit({ query: "", status: "idle", results: [], error: null });
      return;
    }
    if (query.length > maxChars) {
      this.commit({
        query,
        status: "error",
        results: [],
        error: "Search terms are limited to 200 characters.",
      });
      return;
    }
    // Keep the previous results visible while the debounce window runs —
    // they are stale-but-close (prefix typing narrows the same match set).
    const mySeq = this.seq;
    const controller = new AbortController();
    this.controller = controller;
    this.timer = this.setT(() => {
      this.timer = null;
      if (mySeq !== this.seq) return; // superseded while waiting
      this.commit({ query, status: "loading", results: [], error: null });
      this.options
        .fetchSuggest(query, controller.signal)
        .then((results) => {
          if (mySeq !== this.seq) return;
          this.controller = null;
          this.commit({ query, status: "done", results, error: null });
        })
        .catch((err: unknown) => {
          if (mySeq !== this.seq) return;
          this.controller = null;
          // A caller-side abort is not an error: a newer setText (or
          // dispose) already superseded this query.
          if (err instanceof DOMException && err.name === "AbortError") return;
          this.commit({
            query,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, this.options.delayMs ?? 200);
  }

  /** Cancel + drop all listeners; the instance is unusable afterwards. */
  dispose(): void {
    this.cancelPending();
    this.seq += 1;
    this.listeners.clear();
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      this.clearT(this.timer);
      this.timer = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }
}
