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
