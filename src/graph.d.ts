// Type definitions for the graph data
interface Node {
  id: string;
  label?: string;
  group?: string;
}

interface Link {
  source: string;
  target: string;
  label?: string;
}

interface GraphData {
  nodes: Node[];
  links: Link[];
}
