import { Box } from "@chakra-ui/react";
import Graph from "./Graph.tsx";
import Selections from "./Selections.tsx";
import { useState } from "react";
import { GraphData } from "react-force-graph-3d";

const Content = () => {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });

  return (
    <Box width="100%" height="100%">
      <Box mb={{ base: 8, md: 2 }}>
        <Selections setGraphData={setGraphData} />
      </Box>
      <Box width="100%" height="60vh" overflow="hidden">
        <Graph graphData={graphData} />
      </Box>
    </Box>
  );
};

export default Content;
