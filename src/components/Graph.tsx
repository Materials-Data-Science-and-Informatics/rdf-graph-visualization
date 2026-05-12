import * as React from "react";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { getGroupColor } from "../utils";
import FullScreenButton from "./FullScreenButton.tsx";
import ResetViewButton from "./ResetViewButton.tsx";
import ThemeSwitch from "./ThemeSwitch.tsx";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
}

const Graph: React.FC<GraphProps> = ({ graphData, width, height }) => {
  // Fullscreen state for graph container
  const [isFullScreen, setIsFullScreen] = useState(false);
  // Separate width/height state to allow fullscreen to override parent dimensions
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);
  // Theme toggle: dark mode (default) vs light mode
  const [switchOn, setSwitchOn] = useState<boolean>(false);

  // Reference to ForceGraph3D instance for camera control
  const fgRef = useRef<any>(null);
  // Cache materials by color to avoid recreating same materials on each render
  const materialCacheRef = useRef<Map<string, THREE.Material>>(new Map());
  // Label color changes based on theme: black on white background, white on dark
  const labelColor = switchOn ? "#000000" : "#ffffff";

  // Copy node ID to clipboard when clicked
  const handleClick = useCallback((node: NodeObject) => {
    if (!node || node.x === undefined || node.y === undefined || node.z === undefined) return;
    navigator.clipboard.writeText((node.id ?? "").toString()).catch(console.error);
  }, []);

  // Update dimensions when fullscreen or parent dimensions change
  useEffect(() => {
    if (isFullScreen) {
      setGraphWidth(window.innerWidth);
      setGraphHeight(window.innerHeight);
    } else {
      setGraphWidth(width);
      setGraphHeight(height);
    }
  }, [isFullScreen, width, height]);

  // Reset camera to fit all nodes in view
  const handleResetView = useCallback(() => {
    if (!fgRef.current || !graphData?.nodes?.length) return;

    // Calculate bounding box of all nodes to determine camera position
    const nodes = graphData.nodes;
    const minX = Math.min(...nodes.map((node) => node.x ?? 0));
    const maxX = Math.max(...nodes.map((node) => node.x ?? 0));
    const minY = Math.min(...nodes.map((node) => node.y ?? 0));
    const maxY = Math.max(...nodes.map((node) => node.y ?? 0));
    const minZ = Math.min(...nodes.map((node) => node.z ?? 0));
    const maxZ = Math.max(...nodes.map((node) => node.z ?? 0));

    // Calculate the center of the bounding box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centerZ = (minZ + maxZ) / 2;

    // Calculate the size of the bounding box
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;

    // Set distance based on the largest dimension of the bounding box
    const distance = Math.max(sizeX, sizeY, sizeZ) * 1.25;

    // Position camera at calculated distance from center, looking at center
    fgRef.current.cameraPosition(
      { x: centerX, y: centerY, z: centerZ + distance },
      { x: centerX, y: centerY, z: centerZ },
      3000 // duration of the transition (in ms)
    );
  }, [graphData]);

  // Memoize node 3D objects to avoid recreating geometries and materials on each render
  // Box geometry for nodes without group (default), sphere for grouped nodes
  // Materials are cached by color to prevent memory leaks and improve performance
  const nodeThreeObject = useMemo(() => {
    const boxGeometry = new THREE.BoxGeometry(8, 8, 8);
    const sphereGeometry = new THREE.SphereGeometry(5);

    return ({ group }: { group: string }) => {
      const geometry = group === "" ? boxGeometry : sphereGeometry;
      const color = getGroupColor(group);
      
      // Check cache for existing material of this color
      let material = materialCacheRef.current.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
        materialCacheRef.current.set(color, material);
      }

      return new THREE.Mesh(geometry, material);
    };
  }, []);

  // Node tooltip label with theme-aware text color
  const nodeLabel = useCallback(
    (node: NodeObject) => `<span style="color: ${labelColor}">${node.label || node.id}</span>`,
    [labelColor]
  );

  // Link tooltip label with theme-aware text color
  const linkLabel = useCallback(
    (d: LinkObject) => `<span style="color: ${labelColor}">${d.label}</span>`,
    [labelColor]
  );

  // Stable callbacks for child components to prevent unnecessary re-renders
  const setIsFullScreenCallback = useCallback((val: boolean) => setIsFullScreen(val), []);
  const setSwitchOnCallback = useCallback((val: boolean) => setSwitchOn(val), []);

  return (
    <Box
      width={isFullScreen ? "100vw" : width}
      height={isFullScreen ? "100vh" : height}
      position={isFullScreen ? "fixed" : "relative"}
      top={isFullScreen ? 0 : "unset"}
      left={isFullScreen ? 0 : "unset"}
      zIndex={isFullScreen ? 9999 : "auto"}
    >
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        width={graphWidth}
        height={graphHeight}
        nodeLabel={nodeLabel}
        linkLabel={linkLabel}
        linkDirectionalArrowLength={7}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.3}
        linkOpacity={0.5}
        linkWidth={5}
        backgroundColor={switchOn ? "#ffffff" : "#000000"}
        nodeThreeObject={nodeThreeObject}
        onNodeClick={handleClick}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        enableNodeDrag={true}
        enableNavigationControls={true}
        showNavInfo={false}
      />
      <FullScreenButton isFullScreen={isFullScreen} setIsFullScreen={setIsFullScreenCallback} />
      <ResetViewButton resetView={handleResetView} />
      <ThemeSwitch switchOn={switchOn} setSwitchOn={setSwitchOnCallback} />
      <Legend />
    </Box>
  );
};

export default Graph;
