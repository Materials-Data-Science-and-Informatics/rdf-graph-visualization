// Type definitions for the graph data
type NodeType = {
    id: string;
  label?: string;
  group?: string;
}

type LinkType = {
  source: string;
  target: string;
  label?: string;
}
