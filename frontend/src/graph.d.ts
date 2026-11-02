// Type definitions for the graph data
type NodeType = {
  id: string;
  label?: string;
  group?: string;
  color?: string;
};

type LinkType = {
  id?: string;
  source: string;
  target: string;
  label?: string;
  color?: string;
};
