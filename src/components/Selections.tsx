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
import { createGraph, rdfGraphToNodes, removeNonConnectedNodes, groups } from "../utils";
import FilterSwitch from "./FilterSwitch.tsx";
import { GraphData, LinkObject } from "react-force-graph-3d";
import LoadingSpinner from "./LoadingSpinner.tsx";

const parseRDF = (rdfData: string, baseUrl: string): GraphData => {
  const store = createGraph(rdfData, baseUrl);
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
  const [loading, setLoading] = useState<boolean>(false);
  const [baseUrl, setBaseUrl] = useState<string>("http://schema.org/");

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
      try {
        if (typeof fileContent === "string") {
          // Ensure the content is a string
          const data = parseRDF(fileContent, baseUrl);
          setGraphData(data);
          setFilteredGraphData(data);
          setIsChecked(false);
          setFilters(new Set<string>());
          console.log(
            `Loaded file: ${file.name} with ${data.nodes.length} nodes and ${data.links.length} links.`
          );
        } else {
          console.error("File content is not a string.");
        }
      } catch (error) {
        console.error("Error parsing RDF:", error);
        window.alert("Error parsing RDF. Please check the file format.");
      }
      setLoading(false);
    };

    // Add error event listener for debugging
    reader.onerror = (error) => {
      console.error("Error reading file:", error);
    };

    console.log("Reading file:", file.name);
    setLoading(true);
    reader.readAsText(file); // Read the file as text
  }, [file]);

  useEffect(() => {
    setLoading(true);
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
        filteredNodes.some(
          (node) => node.id === (typeof link.source === "object" ? link.source?.id : link.source)
        ) &&
        filteredNodes.some(
          (node) => node.id === (typeof link.target === "object" ? link.target?.id : link.target)
        )
      );
    });
    const filteredGraph = { nodes: filteredNodes, links: filteredLinks };

    if (isChecked) {
      const connectedNodes = removeNonConnectedNodes(filteredGraph);
      const unconnectedGraph = { nodes: connectedNodes, links: filteredGraph.links };
      setFilteredGraphData(unconnectedGraph);
      console.log(
        `Filtered graph with ${connectedNodes.length} nodes and ${filteredGraph.links.length} links.`
      );
    } else {
      setFilteredGraphData(filteredGraph);
      console.log(
        `Filtered graph with ${filteredGraph.nodes.length} nodes and ${filteredGraph.links.length} links.`
      );
    }
    setLoading(false);
  }, [isChecked, filters]);

  if (loading) {
    return <LoadingSpinner />;
  }

  return (
    <Box p={4} borderWidth="1px" borderRadius="lg" width="100%" mx="auto">
      <VStack spacing={4} alignItems="flex-start">
        <HStack spacing={4} alignItems="flex-start">
          <FormControl>
            <FormLabel htmlFor="base-url">RDF Base URL</FormLabel>
            <Input
              id="base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </FormControl>
          <FormControl>
            <FormLabel htmlFor="file-upload">Upload a turtle file</FormLabel>
            <Input id="file-upload" type="file" accept=".rdf, .ttl" onChange={handleFileChange} />
            {file && <Box mt={2}>Selected File: {file.name}</Box>}
          </FormControl>
        </HStack>

        <VStack spacing={1} alignItems="flex-start">
          <FormControl>
            <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
              Remove nodes that are not linked
            </Checkbox>
          </FormControl>
        </VStack>

        <Heading as="h4" size="md">
          Filter by group
        </Heading>

        <HStack spacing={2}>
          {groups.map((group) => (
            <FilterSwitch name={group} filters={filters} setFilters={setFilters} />
          ))}
        </HStack>
      </VStack>
    </Box>
  );
};

export default Selections;
