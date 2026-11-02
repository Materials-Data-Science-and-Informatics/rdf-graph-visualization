import { Box, Flex, useBreakpointValue, useDisclosure } from "@chakra-ui/react";
import { ReactNode, useState } from "react";
import Navbar from "./Navbar";
import Footer from "./Footer";
import ConfigModal from "./TextModal";
import { getConfigSnapshot } from "../config";

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

  const handleInfoClick = () => {
    const info = `Overview
This graph explorer loads bounded graph slices from the backend API as typed JSON and visualizes them in 3D. Check the [repository](https://github.com/Materials-Data-Science-and-Informatics/rdf-graph-visualization) for more information.

Features
- filter the nodes by groups
- remove unlinked nodes
- The renderer config (palette and properties) is fetched at runtime from the backend API (/api/config)
- see the active graph configuration by clicking the 'Config' button.

If your graph has more than 2000 nodes, it might take a while to load. Please wait until graph elements are rendered (stop spinning) before interacting with the graph.`;
    setModalTitle("Info");
    setModalText(info);
    onOpen();
  };

  const handleConfigClick = () => {
    // Card C4: show the LIVE /api/config payload (fetched at startup), not a
    // build-time-bundled file — what you see is what the app rendered with.
    const snapshot = getConfigSnapshot();
    setModalTitle("Config (/api/config)");
    setModalText(snapshot ? JSON.stringify(snapshot, null, 2) : "Config not loaded yet.");
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
