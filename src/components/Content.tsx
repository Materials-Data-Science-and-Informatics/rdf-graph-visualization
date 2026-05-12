import { Box } from "@chakra-ui/react";
import Graph from "./Graph";
import Selections from "./Selections";
import { useState, useRef } from "react";
import useResizeObserver from "@react-hook/resize-observer";
import { GraphData } from "react-force-graph-3d";

// Debounce delay for resize observer to prevent excessive re-renders during window resize
const DEBOUNCE_MS = 150;

const Content = () => {
  // Filtered graph data shown in the visualization (after applying filters)
  const [filteredGraphData, setFilteredGraphData] = useState<GraphData>({ nodes: [], links: [] });
  // Original graph data loaded from RDF file
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  // Reference to the graph container for resize observation
  const boxRef = useRef<HTMLDivElement | null>(null);
  // Current dimensions of the graph container
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Timeout reference for debouncing resize events
  const resizeTimeoutRef = useRef<number | null>(null);
  // Key to force graph recreation when filters change
  const [graphKey, setGraphKey] = useState(0);

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

  return (
    <Box width="100%" mb={4}>
      <Selections
        setGraphData={setGraphData}
        graphData={graphData}
        setFilteredGraphData={setFilteredGraphData}
        setGraphKey={setGraphKey}
      />
      <Box
        ref={boxRef}
        width="100%"
        height="calc(100vh - 220px)"
        overflow="hidden"
      >
        <Graph key={graphKey} graphData={filteredGraphData} width={size.width} height={size.height} />
      </Box>
    </Box>
  );
};

export default Content;
