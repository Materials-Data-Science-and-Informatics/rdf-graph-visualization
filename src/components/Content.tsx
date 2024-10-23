// Content.tsx
import { Box } from "@chakra-ui/react";
import Graph from "./Graph";
import Selections from "./Selections";
import { useState, useRef } from "react";
import useResizeObserver from "@react-hook/resize-observer"; // Import the hook directly
import { GraphData } from "react-force-graph-3d";

const Content = () => {
  const [filteredGraphData, setFilteredGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const boxRef = useRef<HTMLDivElement | null>(null); // Create a ref for the Box
  const [size, setSize] = useState({ width: 0, height: 0 }); // Initialize size state

  // Use useResizeObserver to monitor size changes
  useResizeObserver(boxRef, (entry) => {
    if (entry) {
      const { width, height } = entry.contentRect; // Get the new width and height
      setSize({ width, height }); // Update the size state
    }
  });

  return (
    <Box width="100%" height="100%">
      <Box mb={{ base: 8, md: 2 }}>
        <Selections
          setGraphData={setGraphData}
          graphData={graphData}
          setFilteredGraphData={setFilteredGraphData}
        />
      </Box>
      <Box ref={boxRef} width="100%" height="60vh" overflow="hidden">
        <Graph graphData={filteredGraphData} width={size.width} height={size.height} />
      </Box>
    </Box>
  );
};

export default Content;
