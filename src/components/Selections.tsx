import { Box, Button, Checkbox, FormControl, FormLabel, Input, VStack } from "@chakra-ui/react";
import React, { useState, Dispatch, SetStateAction } from "react";
import { createGraph, rdfGraphToNodes } from "../utils";
import { GraphData } from "react-force-graph-3d";

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
  const [isChecked, setIsChecked] = useState(false);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] || null;
    setFile(selectedFile);
  };

  const handleCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsChecked(event.target.checked);
  };

  const handleSubmit = () => {
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
  };

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

        <Button colorScheme="blue" onClick={handleSubmit}>
          Submit
        </Button>
      </VStack>
    </Box>
  );
};

export default Selections;
