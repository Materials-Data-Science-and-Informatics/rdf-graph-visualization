import { Box, Checkbox, FormControl, FormLabel, Input, VStack,Heading,HStack } from "@chakra-ui/react";
import * as React from "react";
import { useState, Dispatch, SetStateAction,useEffect } from "react";
import { createGraph, rdfGraphToNodes } from "../utils";
import { GraphData } from "react-force-graph-3d";
import {groups} from "./utils.tsx";
import FilterSwitch from "./FilterSwitch.tsx";


const parseRDF = async (
  rdfData: string,
  removeUnconnectedNodes: boolean,
  callback: (data: GraphData) => void
) => {
  const store = createGraph(rdfData, "http://schema.org/");
  const graphData = rdfGraphToNodes(store, removeUnconnectedNodes);
  callback(graphData);
};

interface SelectionsProps {
  setGraphData: Dispatch<SetStateAction<GraphData>>;
}

const Selections: React.FC<SelectionsProps> = ({ setGraphData }: SelectionsProps) => {
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
        parseRDF(fileContent, isChecked, setGraphData);
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
  }, [file, isChecked, setGraphData]);





  return (
    <Box p={4} borderWidth="1px" borderRadius="lg" width="100%" mx="auto">
      <VStack spacing={4}>
        <FormControl>
          <FormLabel htmlFor="file-upload">Upload a file</FormLabel>
          <Input id="file-upload" type="file" accept=".rdf, .ttl" onChange={handleFileChange} />
        </FormControl>

        <FormControl>
          <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
            Remove nodes that are not linked
          </Checkbox>
        </FormControl>

        <Heading as='h4' size='md'>Filter by group</Heading>
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
