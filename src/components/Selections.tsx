import {
  Box,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  VStack,
  HStack,
  Button,
  Text,
  useDisclosure,
} from "@chakra-ui/react";
import * as React from "react";
import { useState, Dispatch, SetStateAction, useEffect } from "react";
import { createGraph, rdfGraphToNodes, removeNonConnectedNodes } from "../utils";
import { GraphData, LinkObject } from "react-force-graph-3d";
import LoadingSpinner from "./LoadingSpinner.tsx";
import ConfigModal from "./TextModal.tsx";

import yaml from "js-yaml";
import configFile from "/config.yml?raw";

const parseRDF = (rdfData: string): GraphData => {
  const store = createGraph(rdfData, "https://schema.org/");
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
  const [isChecked, setIsChecked] = useState<boolean>(true);
  const [filters, setFilters] = useState<Set<string>>(new Set<string>());
  const [loading, setLoading] = useState<boolean>(false);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [modalText, setModalText] = useState<string>("");

  const yamlContent = yaml.dump(yaml.load(configFile));

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

    reader.onerror = (error) => {
      console.error("Error reading file:", error);
    };

    console.log("Reading file:", file.name);
    setLoading(true);
    reader.readAsText(file);
  }, [file]);

  // Filter graph data based on selected groups and optionally remove unconnected nodes
  // Uses requestIdleCallback to avoid blocking the main thread during heavy filtering
  useEffect(() => {
    setLoading(true);

    requestIdleCallback(() => {
      // Filter nodes by selected groups; if no filters, show all nodes
      const filteredNodes =
        filters.size === 0
          ? graphData.nodes
          : graphData.nodes.filter((node) => {
              // Handle "Default" filter by mapping it to empty string group
              const tempFilters = new Set(filters);
              if (filters.has("Default")) {
                tempFilters.delete("Default");
                tempFilters.add("");
              }
              return !tempFilters.has(node.group);
            });

      // Create a Set of node IDs for O(1) lookup during link filtering
      const connectedNodeIds = new Set(filteredNodes.map((node) => node.id));

      // Filter links to only include those connecting remaining nodes
      // Using Set.has() instead of Array.some() for better performance
      const filteredLinks = graphData.links.filter((link: LinkObject) => {
        const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
        const targetId = typeof link.target === "object" ? link.target?.id : link.target;
        return connectedNodeIds.has(sourceId) && connectedNodeIds.has(targetId);
      });

      const filteredGraph = { nodes: filteredNodes, links: filteredLinks };

      // Optionally remove nodes that have no connections
      if (isChecked) {
        const connectedNodes = removeNonConnectedNodes(filteredGraph);
        setFilteredGraphData({ nodes: connectedNodes, links: filteredGraph.links });
      } else {
        setFilteredGraphData(filteredGraph);
      }
      setLoading(false);
    });
  }, [isChecked, filters, graphData]);

  if (loading) {
    return <LoadingSpinner />;
  }

  const handleConfigClick = () => {
    setModalText(yamlContent);
    onOpen();
  };

  const handleInfoClick = () => {
    const info = `Overview
This simple RDF visualizer allows you to upload a turtle file and visualize the graph. Check examples in the [repository](https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization) for sample config and turtle files.

Features
- filter the nodes by groups
- remove unlinked nodes
- The config file is loaded from a YAML file
- see and update the graph configuration by clicking the 'Show config' button.

If your graph has more than 2000 nodes, it might take a while to load. Please wait until graph elements are rendered (stop spinning) before interacting with the graph.`;
    setModalText(info);
    onOpen();
  };

  return (
    <Box p={4} width="100%" mx="auto">
      <VStack spacing={4} alignItems="flex-start">
        <HStack spacing={4} alignItems="flex-start">
          <FormControl>
            <FormLabel htmlFor="file-upload">Upload a turtle file</FormLabel>
            <Input
              id="file-upload"
              type="file"
              accept=".rdf, .ttl"
              display="none"
              onChange={handleFileChange}
            />
            <label htmlFor="file-upload">
              <Button colorScheme="blue" as="span">
                {file ? "Upload new file" : "Upload file"}
              </Button>
            </label>
            {file && (
              <Text mt={2} color="gray.500">
                {file.name}
              </Text>
            )}
          </FormControl>
          <VStack>
            <FormControl>
              <Button onClick={handleInfoClick}>Show Info</Button>
            </FormControl>
            <FormControl>
              <Button onClick={handleConfigClick}>Show Config</Button>
            </FormControl>
          </VStack>
        </HStack>

        <VStack spacing={1} alignItems="flex-start">
          <FormControl>
            <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
              Remove nodes that are not linked
            </Checkbox>
          </FormControl>
        </VStack>
      </VStack>
      <ConfigModal isOpen={isOpen} onClose={onClose} text={modalText} />
    </Box>
  );
};

export default Selections;
