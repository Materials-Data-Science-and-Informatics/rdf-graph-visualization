import {
  Box,
  Checkbox,
  Input,
  HStack,
  Button,
  Text,
} from "@chakra-ui/react";
import * as React from "react";
import { useState, Dispatch, SetStateAction, useEffect } from "react";
import { createGraph, rdfGraphToNodes } from "../utils";
import { GraphData, LinkObject } from "react-force-graph-3d";
import LoadingSpinner from "./LoadingSpinner.tsx";

const parseRDF = (rdfData: string): GraphData => {
  const store = createGraph(rdfData, "https://schema.org/");
  return rdfGraphToNodes(store);
};

interface SelectionsProps {
  graphData: GraphData;
  setGraphData: Dispatch<SetStateAction<GraphData>>;
  setFilteredGraphData: Dispatch<SetStateAction<GraphData>>;
  setGraphKey: Dispatch<SetStateAction<number>>;
}

const Selections: React.FC<SelectionsProps> = ({
  graphData,
  setGraphData,
  setFilteredGraphData,
  setGraphKey,
}: SelectionsProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [isChecked, setIsChecked] = useState<boolean>(false);
  const [filters, setFilters] = useState<Set<string>>(new Set<string>());
  const [loading, setLoading] = useState<boolean>(false);

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

    reader.onload = () => {
      const fileContent = reader.result;
      try {
        if (typeof fileContent === "string") {
          const data = parseRDF(fileContent);
          setGraphData(data);
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

    reader.onerror = (error) => {
      console.error("Error reading file:", error);
    };

    console.log("Reading file:", file.name);
    setLoading(true);
    reader.readAsText(file);
  }, [file]);

  // Filter graph data based on selected groups and optionally remove unconnected nodes
  useEffect(() => {
    if (graphData.nodes.length === 0) {
      setFilteredGraphData({ nodes: [], links: [] });
      return;
    }

    setLoading(true);

    const processFiltering = () => {
      // Filter nodes by selected groups; if no filters, show all nodes
      const filteredNodes =
        filters.size === 0
          ? graphData.nodes
          : graphData.nodes.filter((node) => {
              const tempFilters = new Set(filters);
              if (filters.has("Default")) {
                tempFilters.delete("Default");
                tempFilters.add("");
              }
              return !tempFilters.has(node.group);
            });

      // Create a Set of node IDs for O(1) lookup
      const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));

      // Filter links to only include those connecting filtered nodes
      const filteredLinks = graphData.links.filter((link: LinkObject) => {
        const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
        const targetId = typeof link.target === "object" ? link.target?.id : link.target;
        return filteredNodeIds.has(sourceId) && filteredNodeIds.has(targetId);
      });

      let newGraphData: GraphData;
      if (!isChecked) {
        // Remove nodes that have no connections in the filtered view
        const connectedNodeIds = new Set(
          filteredLinks.flatMap((link) => {
            const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
            const targetId = typeof link.target === "object" ? link.target?.id : link.target;
            return [sourceId, targetId];
          })
        );
        const connectedNodes = filteredNodes.filter((node) => connectedNodeIds.has(node.id));
        newGraphData = { nodes: connectedNodes, links: filteredLinks };
      } else {
        // Show all filtered nodes with all their links
        newGraphData = { nodes: filteredNodes, links: filteredLinks };
      }

      // ForceGraph mutates graph objects in place, so pass fresh copies on every UI-driven update.
      const graphSnapshot: GraphData = {
        nodes: newGraphData.nodes.map((node) => ({ ...node })),
        links: newGraphData.links.map((link) => ({
          ...link,
          source: typeof link.source === "object" ? link.source?.id : link.source,
          target: typeof link.target === "object" ? link.target?.id : link.target,
        })),
      };

      setFilteredGraphData(graphSnapshot);
      setGraphKey((k) => k + 1);
      setLoading(false);
    };

    if (graphData.nodes.length > 500) {
      requestIdleCallback(processFiltering);
    } else {
      processFiltering();
    }
  }, [isChecked, filters, graphData, setFilteredGraphData, setGraphKey]);

  if (loading) {
    return <LoadingSpinner />;
  }

  return (
    <Box p={4} width="100%" mx="auto">
      <HStack spacing={4} alignItems="center">
        <Input
          id="file-upload"
          type="file"
          accept=".rdf, .ttl"
          display="none"
          onChange={handleFileChange}
        />
        <label htmlFor="file-upload">
          <Button colorScheme="blue" as="span">
            {file ? "Upload new file" : "Upload a turtle file"}
          </Button>
        </label>
        {file && (
          <Text mt={2} color="gray.500">
            {file.name}
          </Text>
        )}
        <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
          Add not connected nodes
        </Checkbox>
      </HStack>
    </Box>
  );
};

export default Selections;
