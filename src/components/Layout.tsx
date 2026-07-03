import { Box, Flex, useBreakpointValue, useDisclosure } from "@chakra-ui/react";
import { ReactNode, useState } from "react";
import Navbar from "./Navbar";
import Footer from "./Footer";
import ConfigModal from "./TextModal";
import yaml from "js-yaml";
import configFile from "/config.yml?raw";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const contentWidth = useBreakpointValue({
    base: "95%", // for screens smaller than 720px
    md: "85%", // for screens between 720px and 1080px
    xl: "75%", // for screens larger than 1080px
  });

  const { isOpen, onOpen, onClose } = useDisclosure();
  const [modalText, setModalText] = useState("");
  const [modalTitle, setModalTitle] = useState("");

  const yamlContent = yaml.dump(yaml.load(configFile));

  const handleInfoClick = () => {
    const info = `Overview
This simple RDF visualizer allows you to upload a turtle file and visualize the graph. Check examples in the [repository](https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization) for sample config and turtle files.

Features
- filter the nodes by groups
- remove unlinked nodes
- The config file is loaded from a YAML file
- see and update the graph configuration by clicking the 'Show config' button.

If your graph has more than 2000 nodes, it might take a while to load. Please wait until graph elements are rendered (stop spinning) before interacting with the graph.`;
    setModalTitle("Info");
    setModalText(info);
    onOpen();
  };

  const handleConfigClick = () => {
    setModalTitle("YAML Config File");
    setModalText(yamlContent);
    onOpen();
  };

  return (
    <Flex minHeight="100vh" flexDirection="column" width="100%" overflowX="hidden">
      <Navbar onInfoClick={handleInfoClick} onConfigClick={handleConfigClick} />
      <Box
        as="main"
        flex="1"
        width={contentWidth}
        mx="auto"
        display="flex"
        flexDirection="column"
        minH={0}
        py={2}
        overflowX="hidden"
      >
        {children}
      </Box>
      <ConfigModal isOpen={isOpen} onClose={onClose} text={modalText} title={modalTitle} />
      <Footer />
    </Flex>
  );
}
