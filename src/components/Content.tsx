import { Box } from "@chakra-ui/react";
import Graph from "./Graph";
import Selections from "./Selections";
import { useState, useRef } from "react";
import useResizeObserver from "@react-hook/resize-observer";
import { GraphData } from "react-force-graph-3d";

const Content = () => {
  const [filteredGraphData, setFilteredGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [isAnimating1, setIsAnimating1] = useState(false); // For orbit animation
  const [isAnimating2, setIsAnimating2] = useState(false);
  const [isAnimating3, setIsAnimating3] = useState(false);

  useResizeObserver(boxRef, (entry) => {
    if (entry) {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    }
  });

  return (
    <Box width="100%" height="100vh">
      <Box mb={{ base: 8, md: 2 }}>
        <Selections
          setGraphData={setGraphData}
          graphData={graphData}
          setFilteredGraphData={setFilteredGraphData}
          isAnimating1={isAnimating1}
          setIsAnimating1={setIsAnimating1}
          isAnimating2={isAnimating2}
          setIsAnimating2={setIsAnimating2}
          isAnimating3={isAnimating3}
          setIsAnimating3={setIsAnimating3}
        />
      </Box>
      <Box ref={boxRef} width="100%" height="60vh" overflow="hidden">
        <Graph
          graphData={filteredGraphData}
          width={size.width}
          height={size.height}
          isAnimating1={isAnimating1}
          isAnimating2={isAnimating2}
          isAnimating3={isAnimating3}
        />
      </Box>
    </Box>
  );
};

export default Content;
