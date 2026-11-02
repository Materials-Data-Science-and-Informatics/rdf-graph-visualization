import { Box } from "@chakra-ui/react";
import Graph from "./Graph";
import Selections from "./Selections";
import { useState, useRef, useCallback } from "react";
import useResizeObserver from "@react-hook/resize-observer";
import { NodeObject, GraphData } from "react-force-graph-3d";
import { graphStore, useSliceActions } from "../store/use-graph-store";

// Debounce delay for resize observer to prevent excessive re-renders during window resize
const DEBOUNCE_MS = 150;

const Content = () => {
  // Filtered graph data shown in the visualization (after applying filters)
  const [filteredGraphData, setFilteredGraphData] = useState<GraphData>({ nodes: [], links: [] });
  // Slice fetch orchestration (load / expand / abort), shared with Selections
  const actions = useSliceActions();
  // Reference to the graph container for resize observation
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Current dimensions of the graph container
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Timeout reference for debouncing resize events
  const resizeTimeoutRef = useRef<number | null>(null);

  // Observe container resize and debounce updates to prevent excessive re-renders
  // Debouncing is especially important for large graphs to maintain smooth UI
  useResizeObserver(boxRef, (entry) => {
    if (entry) {
      // Clear any pending resize timeout to debounce rapid resize events
      if (resizeTimeoutRef.current) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      // Set new timeout to update dimensions after debounce delay
      resizeTimeoutRef.current = window.setTimeout(() => {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }, DEBOUNCE_MS);
    }
  });

  // Expand-on-click (card C2 DoD): clicking a node selects + focuses it and
  // grows the store with the NEXT cursor page — no refetch-all.
  const handleNodeSelect = useCallback(
    (node: NodeObject) => {
      const id = typeof node.id === "string" ? node.id : String(node.id ?? "");
      if (!id) return;
      graphStore.select(id);
      graphStore.focus(id);
      if (graphStore.canExpand) {
        actions.expand();
      }
    },
    [actions]
  );

  return (
    <Box width="100%" flex="1" minH={0} display="flex" flexDirection="column" gap={4}>
      <Selections setFilteredGraphData={setFilteredGraphData} actions={actions} />
      <Box
        ref={boxRef}
        width="100%"
        flex="1"
        minH={{ base: "360px", md: "480px" }}
        overflow="hidden"
        position="relative"
      >
        <Graph
          graphData={filteredGraphData}
          width={size.width}
          height={size.height}
          onNodeSelect={handleNodeSelect}
        />
      </Box>
    </Box>
  );
};

export default Content;
