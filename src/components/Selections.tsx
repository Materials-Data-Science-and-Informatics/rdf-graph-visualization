import {
  Box,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  VStack,
  Heading,
  HStack,
} from "@chakra-ui/react";
import * as React from "react";
import { useState, Dispatch, SetStateAction, useEffect } from "react";
import { createGraph, rdfGraphToNodes, removeNonConnectedNodes } from "../utils";
import { groups } from "./utils.tsx";
import FilterSwitch from "./FilterSwitch.tsx";
import { GraphData, LinkObject } from "react-force-graph-3d";

const parseRDF = (rdfData: string): GraphData => {
  const store = createGraph(rdfData, "http://schema.org/");
  return rdfGraphToNodes(store);
};

interface SelectionsProps {
  graphData: GraphData;
  setGraphData: Dispatch<SetStateAction<GraphData>>;
  setFilteredGraphData: Dispatch<SetStateAction<GraphData>>;
}

const Selections: React.FC<SelectionsProps> = ({
  graphData,
  setGraphData,
  setFilteredGraphData,
}: SelectionsProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [isChecked, setIsChecked] = useState<boolean>(false);
  const [filters, setFilters] = useState<Set<string>>(new Set<string>());

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    setFile(selectedFile);
  };

  const handleCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsChecked(event.target.checked);
  };

  useEffect(() => {
    if (!file) {
      console.log("No file selected.");
      return;
    }

    const reader = new FileReader();

    // Add the load event listener
    reader.onload = () => {
      const fileContent = reader.result;
      if (typeof fileContent === "string") {
        // Ensure the content is a string
        const data = parseRDF(fileContent);
        setGraphData(data);
        setFilteredGraphData(data);
      } else {
        console.error("File content is not a string.");
      }
    };

    // Add error event listener for debugging
    reader.onerror = (error) => {
      console.error("Error reading file:", error);
    };

    console.log("Reading file:", file.name);
    reader.readAsText(file); // Read the file as text
  }, [file]);

  useEffect(() => {
    // first, filter
    const filteredNodes = graphData.nodes.filter((node) => {
      // if no filters are selected, show all nodes
      if (filters.size === 0) {
        return true;
      }
      // otherwise, dont show nodes that match the selected filters
      return !filters.has(node.group);
    });
    const filteredLinks = graphData.links.filter((link: LinkObject) => {
      // link should be shown if both source or target is in the filtered nodes
      return (
        filteredNodes.some((node) => node.id === link.source?.id) &&
        filteredNodes.some((node) => node.id === link.target?.id)
      );
    });
    const filteredGraph = { nodes: filteredNodes, links: filteredLinks };

    if (isChecked) {
      const connectedNodes = removeNonConnectedNodes(filteredGraph);
      const unconnectedGraph = { nodes: connectedNodes, links: filteredGraph.links };
      setFilteredGraphData(unconnectedGraph);
    } else {
      setFilteredGraphData(filteredGraph);
    }
  }, [isChecked, filters]);

  return (
    <Box p={4} borderWidth="1px" borderRadius="lg" width="100%" mx="auto">
      <VStack spacing={4} alignItems="flex-start">
        <FormControl>
          <FormLabel htmlFor="file-upload">Upload a file</FormLabel>
          <Input id="file-upload" type="file" accept=".rdf, .ttl" onChange={handleFileChange} />
        </FormControl>

        <FormControl>
          <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
            Remove nodes that are not linked
          </Checkbox>
        </FormControl>

        <Heading as="h4" size="md">
          Filter by group
        </Heading>

        <HStack spacing={2}>
          {groups.map((group) => (
            <FilterSwitch key={group} name={group} filters={filters} setFilters={setFilters} />
          ))}
        </HStack>
      </VStack>
    </Box>
  );
};

export default Selections;
