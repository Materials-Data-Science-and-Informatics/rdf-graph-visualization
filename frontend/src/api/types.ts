// Generated-by-hand mirror of backend/app/contract.py (card F3).
// tests/test_contract.py fails the build if the two drift.
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

export interface Node {
  id: string;
  label: string;
  type: NodeType;
  group: string;
  purl?: string | null;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  label: string;
}

export interface Page {
  cursor?: string | null;
  limit: number;
  truncated: boolean;
}

export interface SubgraphResponse {
  nodes: Node[];
  edges: Edge[];
  page: Page;
}

export interface AggregateNode {
  group: string;
  type: NodeType;
  count: number;
}

export interface AggregateResponse {
  nodes: AggregateNode[];
}

export interface SearchResult {
  id: string;
  label: string;
  type: NodeType;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface EntityResponse {
  node: Node;
  properties: Record<string, string[]>;
}

export interface ConfigTypePreset {
  group: string;
  type: NodeType;
  color: string;
}

export interface ConfigResponse {
  relation_properties: string[];
  label_properties: string[];
  skip_types: string[];
  types: ConfigTypePreset[];
}

export interface HealthResponse {
  status: string;
  qlever_url: string;
  default_limit: number;
  max_limit: number;
}
