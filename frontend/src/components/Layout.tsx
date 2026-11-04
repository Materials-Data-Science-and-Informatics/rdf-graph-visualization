import { useState, type ReactNode } from "react";
import Navbar from "./Navbar";
import Footer from "./Footer";
import ConfigModal from "./TextModal";
import { getConfigSnapshot } from "../config";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [isOpen, setIsOpen] = useState(false);
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
    setIsOpen(true);
  };

  const handleConfigClick = () => {
    // Card C4: show the LIVE /api/config payload (fetched at startup), not a
    // build-time-bundled file — what you see is what the app rendered with.
    const snapshot = getConfigSnapshot();
    setModalTitle("Config (/api/config)");
    setModalText(snapshot ? JSON.stringify(snapshot, null, 2) : "Config not loaded yet.");
    setIsOpen(true);
  };

  return (
    <div className="flex min-h-screen w-full flex-col overflow-x-hidden">
      <Navbar onInfoClick={handleInfoClick} onConfigClick={handleConfigClick} />
      <main className="mx-auto flex w-[95%] min-h-0 flex-1 flex-col overflow-x-hidden py-2 md:w-[85%] xl:w-[75%]">
        {children}
      </main>
      <ConfigModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        text={modalText}
        title={modalTitle}
      />
      <Footer />
    </div>
  );
}
