// React binding for the entity detail panel (card E2).
//
// When a node is selected, the panel needs that one entity's property view
// (GET /api/entity/{iri}, card B2). The fetch is short-lived and per-node, so
// it is NOT part of the graph store: it lives in a small observable
// EntityLoader that owns one AbortController. A newer selection (or unmount)
// aborts the in-flight fetch, and a response whose controller was already
// aborted — i.e. superseded — is dropped instead of clobbering the current
// state. This is the same pure-observable + useSyncExternalStore shape as
// use-graph-store.ts, and the same abort/stale semantics as useSliceActions.
//
// EntityLoader is deliberately UI-free (no React, no DOM): the fetch is
// injectable, so the headless test suite drives it with a stubbed fetch.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ApiError, getEntity, type FetchOptions } from "../api/client";
import type { EntityResponse } from "../api/types";

export type EntityStatus = "idle" | "loading" | "ready" | "error";

export interface EntityLoadState {
  /** IRI currently loaded or loading (null when nothing is selected). */
  iri: string | null;
  status: EntityStatus;
  data: EntityResponse | null;
  error: string | null;
}

type EntityFetcher = (iri: string, options?: FetchOptions) => Promise<EntityResponse>;

function describe(err: unknown): string {
  // ApiError messages are already self-describing (kind, endpoint, status).
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export class EntityLoader {
  private state: EntityLoadState = { iri: null, status: "idle", data: null, error: null };
  private controller: AbortController | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly fetchEntity: EntityFetcher;

  constructor(fetchEntity: EntityFetcher = getEntity) {
    this.fetchEntity = fetchEntity;
  }

  // ---------------------------------------------------------------- observers

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Snapshot token for useSyncExternalStore (a number is stable enough). */
  getSnapshot = (): number => this.version;

  /** Current immutable state; the same reference until the next change. */
  getState = (): EntityLoadState => this.state;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // ---------------------------------------------------------------------- load

  /**
   * Load the entity for ``iri``. Passing null clears the panel (idle). Any
   * in-flight load is aborted first; a response whose controller was already
   * aborted (superseded by a newer load or a cancel) is dropped.
   */
  load(iri: string | null): void {
    this.controller?.abort();
    if (iri === null) {
      this.state = { iri: null, status: "idle", data: null, error: null };
      this.emit();
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.state = { iri, status: "loading", data: null, error: null };
    this.emit();
    void (async () => {
      try {
        const data = await this.fetchEntity(iri, { signal: controller.signal });
        if (controller.signal.aborted) return; // superseded — do not clobber
        this.state = { iri, status: "ready", data, error: null };
        this.emit();
      } catch (err) {
        if (controller.signal.aborted) return; // superseded/cancelled — drop
        this.state = { iri, status: "error", data: null, error: describe(err) };
        this.emit();
      }
    })();
  }

  /** Abort the in-flight load (unmount). Leaves the current state untouched. */
  cancel(): void {
    this.controller?.abort();
  }
}

/** App-wide singleton (card E2), mirroring the graphStore pattern. */
export const entityLoader = new EntityLoader();

/**
 * React binding: load the entity for ``iri`` (null = nothing selected) and
 * re-render on every state change. The in-flight load aborts when ``iri``
 * changes and on unmount. Returns the current load state (read fresh on each
 * re-render, keyed by the store's change token).
 */
export function useEntity(iri: string | null): EntityLoadState {
  const version = useSyncExternalStore(
    entityLoader.subscribe,
    entityLoader.getSnapshot,
    entityLoader.getSnapshot
  );
  useEffect(() => {
    entityLoader.load(iri);
    return () => {
      entityLoader.cancel();
    };
  }, [iri]);
  // `version` is the loader's change token; the memo recomputes on every bump.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => entityLoader.getState(), [version]);
}
