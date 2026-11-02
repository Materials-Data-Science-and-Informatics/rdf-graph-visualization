// Typed fetch client for the frozen HKG API contract (card C1).
//
// One function per endpoint, returning the exact types from ./types.ts — the
// hand-mirrored twins of backend/app/contract.py (the backend contract test
// fails the build if they drift).
//
// Cancellation model: every call owns an AbortController. A caller-supplied
// `signal` propagates into it (so components can abort stale fetches on
// unmount/re-fetch), and a per-endpoint timeout is enforced on top. Timeouts
// raise ApiError(kind="timeout"); caller aborts surface as the original
// AbortError.

import type {
  AggregateResponse,
  ConfigResponse,
  EntityResponse,
  HealthResponse,
  NodeType,
  SearchResponse,
  SubgraphResponse,
} from "./types";

const DEFAULT_API_BASE = "/api";

let apiBase: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL ??
  DEFAULT_API_BASE;

/** Override the API origin at runtime (used by tests; apps rely on the env/proxy). */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, "");
}

export function getApiBase(): string {
  return apiBase;
}

export type FailureKind = "network" | "timeout" | "http" | "parse";

export class ApiError extends Error {
  readonly kind: FailureKind;
  readonly status?: number;

  constructor(kind: FailureKind, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface FetchOptions {
  /** Caller-side cancellation; propagated into the call's own controller. */
  signal?: AbortSignal;
  /** Override the per-endpoint timeout in ms. */
  timeoutMs?: number;
}

/** Per-endpoint default timeouts (ms). Slices are the slow path; probes fast. */
const TIMEOUTS = {
  health: 10_000,
  config: 10_000,
  search: 10_000,
  entity: 15_000,
  aggregate: 20_000,
  subgraph: 30_000,
} as const;

/**
 * Low-level typed GET. Kept exported so endpoint wrappers and tests share the
 * same abort/timeout/error semantics.
 */
export async function fetchJson<T>(
  path: string,
  timeoutMs: number,
  options: FetchOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const caller = options.signal;
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller?.aborted) {
    controller.abort(caller.reason);
  } else if (caller) {
    caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timedOut = { value: false };
  const timer = setTimeout(() => {
    timedOut.value = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, options.timeoutMs ?? timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (timedOut.value) {
      throw new ApiError(
        "timeout",
        `Request to ${path} timed out after ${options.timeoutMs ?? timeoutMs} ms`
      );
    }
    if (caller?.aborted) {
      throw caller.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }
    throw new ApiError(
      "network",
      `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (body.detail !== undefined) {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError("http", `${path} responded ${res.status}: ${detail}`, res.status);
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ApiError(
      "parse",
      `${path} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export interface SubgraphQuery {
  /** Restrict to one data-model class (NodeType). */
  type?: NodeType;
  /** Max nodes in the slice; server clamps to max_limit. */
  limit?: number;
  /** Cursor from a previous page; first call omits it. */
  cursor?: string | null;
}

/** GET /api/subgraph — bounded, cursor-paginated graph slice. */
export function getSubgraph(
  query: SubgraphQuery = {},
  options: FetchOptions = {}
): Promise<SubgraphResponse> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();
  return fetchJson<SubgraphResponse>(`/subgraph${qs ? `?${qs}` : ""}`, TIMEOUTS.subgraph, options);
}

/** GET /api/aggregate — node counts per group/type. */
export function getAggregate(options: FetchOptions = {}): Promise<AggregateResponse> {
  return fetchJson<AggregateResponse>("/aggregate", TIMEOUTS.aggregate, options);
}

/** GET /api/search?q= — label prefix search for autocomplete. */
export function searchEntities(query: string, options: FetchOptions = {}): Promise<SearchResponse> {
  return fetchJson<SearchResponse>(
    `/search?q=${encodeURIComponent(query)}`,
    TIMEOUTS.search,
    options
  );
}

/** GET /api/entity/{iri} — node + properties for one entity. */
export function getEntity(iri: string, options: FetchOptions = {}): Promise<EntityResponse> {
  return fetchJson<EntityResponse>(`/entity/${encodeURIComponent(iri)}`, TIMEOUTS.entity, options);
}

/** GET /api/config — palette/label/relation presets from the pinned data model. */
export function getConfig(options: FetchOptions = {}): Promise<ConfigResponse> {
  return fetchJson<ConfigResponse>("/config", TIMEOUTS.config, options);
}

/** GET /api/health — liveness probe (qlever URL, limit bounds). */
export function getHealth(options: FetchOptions = {}): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/health", TIMEOUTS.health, options);
}
