import { Box, Collapse, useDisclosure, Text, HStack, IconButton } from "@chakra-ui/react";
import Graph from "./Graph";
import Selections from "./Selections";
import { useState, useRef } from "react";
import useResizeObserver from "@react-hook/resize-observer";
import { GraphData } from "react-force-graph-3d";
import { CiSquareChevUp, CiSquareChevDown } from "react-icons/ci";

const Content = () => {
  const [filteredGraphData, setFilteredGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { isOpen, onToggle } = useDisclosure({ defaultIsOpen: true });

  useResizeObserver(boxRef, (entry) => {
    if (entry) {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    }
  });

  return (
    <Box width="100%">
      <Box borderWidth="1px" borderRadius="lg" mb={2} p={4}>
        <HStack justifyContent="space-between" alignItems="center">
          <Text fontSize="lg" fontWeight="bold">
            Configuration
          </Text>

          {/* Button to toggle collapse */}
          <IconButton
            variant="ghost"
            fontSize="3xl"
            onClick={onToggle}
            icon={isOpen ? <CiSquareChevUp /> : <CiSquareChevDown />}
            aria-label="toogle configuration"
          />
        </HStack>
        {/* Collapsible content */}
        <Collapse in={isOpen}>
          <Box mb={{ base: 8, md: 2 }}>
            <Selections
              setGraphData={setGraphData}
              graphData={graphData}
              setFilteredGraphData={setFilteredGraphData}
            />
          </Box>
        </Collapse>
      </Box>
      <Box ref={boxRef} width="100%" height={isOpen ? "32vh" : "64vh"} overflow="hidden">
        <Graph graphData={filteredGraphData} width={size.width} height={size.height} />
      </Box>
    </Box>
  );
};

export default Content;
