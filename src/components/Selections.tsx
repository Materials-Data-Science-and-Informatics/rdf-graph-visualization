import {
  Box,
  Checkbox,
  FormControl,
  FormLabel,
  Input,
  VStack,
  Heading,
  HStack,
  Radio,
  RadioGroup,
  Stack,
} from "@chakra-ui/react";
import * as React from "react";
import { useState, Dispatch, SetStateAction, useEffect } from "react";
import { createGraph, rdfGraphToNodes, removeNonConnectedNodes, groups } from "../utils";
import FilterSwitch from "./FilterSwitch.tsx";
import { GraphData, LinkObject } from "react-force-graph-3d";
import LoadingSpinner from "./LoadingSpinner.tsx";

const parseRDF = (rdfData: string): GraphData => {
  const store = createGraph(rdfData, "http://schema.org/");
  return rdfGraphToNodes(store);
};

interface SelectionsProps {
  graphData: GraphData;
  setGraphData: Dispatch<SetStateAction<GraphData>>;
  setFilteredGraphData: Dispatch<SetStateAction<GraphData>>;
  isAnimating1: boolean;
  setIsAnimating1: Dispatch<SetStateAction<boolean>>;
  isAnimating2: boolean;
  setIsAnimating2: Dispatch<SetStateAction<boolean>>;
  isAnimating3: boolean;
  setIsAnimating3: Dispatch<SetStateAction<boolean>>;
}

const Selections: React.FC<SelectionsProps> = ({
  graphData,
  setGraphData,
  setFilteredGraphData,
  isAnimating1,
  setIsAnimating1,
  isAnimating2,
  setIsAnimating2,
  isAnimating3,
  setIsAnimating3,
}: SelectionsProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [isChecked, setIsChecked] = useState<boolean>(false);
  const [filters, setFilters] = useState<Set<string>>(new Set<string>());
  const [loading, setLoading] = useState<boolean>(false);
  const [animationOn, setAnimationOn] = useState<boolean>(false);

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

  const onRadioChange = (value: string) => {
    if (value === "zoomOut") {
      setIsAnimating1(true);
      setIsAnimating2(false);
      setIsAnimating3(false);
    } else if (value === "personZoomIn") {
      setIsAnimating1(false);
      setIsAnimating2(true);
      setIsAnimating3(false);
    } else if (value === "creativeWorkZoomIn") {
      setIsAnimating1(false);
      setIsAnimating2(false);
      setIsAnimating3(true);
    }
  };
  return (
    <Box p={4} borderWidth="1px" borderRadius="lg" width="100%" mx="auto">
      <VStack spacing={4} alignItems="flex-start">
        <FormControl>
          <FormLabel htmlFor="file-upload">Upload a file</FormLabel>
          <Input id="file-upload" type="file" accept=".rdf, .ttl" onChange={handleFileChange} />
        </FormControl>

        <VStack spacing={1} alignItems="flex-start">
          <FormControl>
            <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
              Remove nodes that are not linked
            </Checkbox>
          </FormControl>

          <FormControl>
            <Checkbox
              isChecked={animationOn}
              onChange={(event) => {
                setAnimationOn(event.target.checked);
                if (!event.target.checked) {
                  setIsAnimating1(false);
                  setIsAnimating2(false);
                  setIsAnimating3(false);
                }
              }}
            >
              Animation On
            </Checkbox>
          </FormControl>

          {animationOn && (
            <FormControl as="fieldset" id="animation-options-control">
              <FormLabel as="legend">Animation Options</FormLabel>
              <RadioGroup defaultValue="none" onChange={onRadioChange}>
                <Stack spacing={4} direction="column">
                  <Radio value="zoomOut" isChecked={isAnimating1}>
                    Animate zoom out and rotation
                  </Radio>
                  <Radio value="personZoomIn" isChecked={isAnimating2}>
                    Animate license zoom-in and rotation
                  </Radio>
                  <Radio value="creativeWorkZoomIn" isChecked={isAnimating3}>
                    Animate creative work zoom-in and rotation
                  </Radio>
                </Stack>
              </RadioGroup>
            </FormControl>
          )}
        </VStack>

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
