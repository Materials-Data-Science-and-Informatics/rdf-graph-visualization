import { Box, Collapse, useDisclosure, Text, HStack, IconButton } from "@chakra-ui/react";
import Graph from "./Graph";
import Selections from "./Selections";
import { useState, useRef, useCallback } from "react";
import useResizeObserver from "@react-hook/resize-observer";
import { GraphData } from "react-force-graph-3d";
import { CiSquareChevUp, CiSquareChevDown } from "react-icons/ci";

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
  // Controls whether configuration panel is expanded
  const { isOpen, onToggle } = useDisclosure({ defaultIsOpen: true });
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
      <Box
        ref={boxRef}
        width="100%"
        height={isOpen ? "calc(100vh - 630px)" : "calc(100vh - 330px)"}
        overflow="hidden"
      >
        <Graph graphData={filteredGraphData} width={size.width} height={size.height} />
      </Box>
    </Box>
  );
};

export default Content;
