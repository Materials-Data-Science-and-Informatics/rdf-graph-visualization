// Mirrors backend/app/contract.py.
export type NodeType =
  | "DataCatalog"
  | "Dataset"
  | "Document"
  | "Event"
  | "Institution"
  | "Instrument"
  | "Software"
  | "Person"
  | "Unknown";

export interface ConfigTypePreset {
  group: string;
  type: NodeType;
  color: string;
}

export interface GraphGroupConfig {
  name: string;
  types: string[];
  color: string;
}

export interface GraphConfig {
  relation_properties: string[];
  label_properties: string[];
  skip_types: string[];
  groups: GraphGroupConfig[];
}

export interface ConfigResponse {
  relation_properties: string[];
  label_properties: string[];
  skip_types: string[];
  types: ConfigTypePreset[];
  graph: GraphConfig;
}

export async function fetchConfig(signal?: AbortSignal): Promise<ConfigResponse> {
  const res = await fetch("/api/config", { signal });
  if (!res.ok) throw new Error(`Backend returned ${res.status} ${res.statusText}`.trim());
  try {
    return (await res.json()) as ConfigResponse;
  } catch {
    throw new Error("Backend returned an invalid (non-JSON) response");
  }
}

// -- /api/search, /api/node, /api/stream (mirrors backend/app/contract.py) -----

export interface SearchResult {
  id: string;
  label: string;
  type: NodeType;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface NodeRelation {
  predicate: string;
  out: number;
  in: number;
}

export interface NodeInfo {
  id: string;
  label: string | null;
  group: string | null;
  types: string[];
  relations: NodeRelation[];
}

export type DoneReason =
  "exhausted" | "max_nodes" | "max_hops" | "time_budget" | "truncated" | "error";

export type StreamEvent =
  | {
      type: "meta";
      root: string;
      max_nodes: number;
      max_hops: number;
      cached?: boolean | null;
      built_at?: string | null;
    }
  | { type: "nodes"; hop: number; nodes: { id: string; group?: string | null }[] }
  | { type: "edges"; hop: number; edges: { s: string; p: string; o: string }[] }
  | { type: "types"; types: Record<string, string | null> }
  | { type: "labels"; labels: Record<string, string> }
  | { type: "progress"; hop: number; nodes: number; edges: number }
  | { type: "error"; message: string }
  | { type: "ping" }
  | { type: "done"; reason: DoneReason };

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, detail?: string) {
    super(`Backend returned ${status} ${statusText}${detail ? `: ${detail}` : ""}`.trim());
    this.name = "HttpError";
    this.status = status;
  }
}

async function httpError(res: Response): Promise<HttpError> {
  let detail: string | undefined;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    /* body is not JSON */
  }
  return new HttpError(res.status, res.statusText, detail);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw await httpError(res);
  return (await res.json()) as T;
}

/** Node summary for the info panel; `null` when the backend does not know the IRI (404). */
export function fetchNode(iri: string, signal?: AbortSignal): Promise<NodeInfo | null> {
  return getJson<NodeInfo>(`/api/node/${encodeURIComponent(iri)}`, signal);
}

/** Prefix search over entity labels (at most 20 hits). */
export async function searchEntities(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const body = await getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, signal);
  return body?.results ?? [];
}

/**
 * Incremental NDJSON line splitter. `push` takes raw bytes (any chunking, also
 * mid-UTF-8-character) and returns the complete non-blank lines; `flush` returns
 * a trailing line without newline.
 */
export class NdjsonLineSplitter {
  private readonly decoder = new TextDecoder();
  private rest = "";

  push(chunk: Uint8Array): string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let start = 0;
    for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
      const line = (this.rest + text.slice(start, nl)).trim(); // trim also drops CR
      this.rest = "";
      if (line) lines.push(line);
      start = nl + 1;
    }
    this.rest += text.slice(start);
    return lines;
  }

  flush(): string[] {
    this.rest += this.decoder.decode();
    const last = this.rest.trim();
    this.rest = "";
    return last ? [last] : [];
  }
}

export interface StreamParams {
  root: string;
  maxNodes?: number;
  maxHops?: number;
}

/**
 * Stream `/api/stream` and call `onEvent` per NDJSON line (including `ping`).
 * Resolves when the stream ends; rejects with `HttpError` on non-200, on network
 * errors, on malformed lines, and with the abort reason when `signal` aborts.
 */
export async function streamGraph(
  params: StreamParams,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const qs = new URLSearchParams({ root: params.root });
  if (params.maxNodes !== undefined) qs.set("max_nodes", String(params.maxNodes));
  if (params.maxHops !== undefined) qs.set("max_hops", String(params.maxHops));
  const res = await fetch(`/api/stream?${qs}`, { signal });
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new Error("Backend returned an empty stream body");
  const reader = res.body.getReader();
  const splitter = new NdjsonLineSplitter();
  const emit = (lines: string[]) => {
    for (const line of lines) {
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        throw new Error("Backend sent a malformed stream line");
      }
      onEvent(event);
    }
  };
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      emit(splitter.push(value));
    }
    signal?.throwIfAborted();
    emit(splitter.flush());
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.cancel().catch(() => undefined);
  }
}
