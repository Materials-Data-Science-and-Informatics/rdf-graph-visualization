import * as React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { getGroupColor } from "../utils";
import FullScreenButton from "./FullScreenButton.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import ResetViewButton from "./ResetViewButton.tsx";
import ThemeSwitch from "./ThemeSwitch.tsx";
interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
}

const Graph: React.FC<GraphProps> = ({ graphData, width, height }) => {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);
  const [switchOn, setSwitchOn] = useState<boolean>(false);

  const fgRef = useRef<any>(null);
  const labelColor = switchOn ? "#000000" : "#ffffff"; // Black on white background, white on dark

  const handleClick = useCallback(
    (node: NodeObject) => {
      if (!node || node.x === undefined || node.y === undefined || node.z === undefined) return;
      // copy node´s id to clipboard
      navigator.clipboard.writeText((node.id ?? "").toString()).then(
        () => {
          console.log("Node ID copied to clipboard: ", node.id);
        },
        (err) => {
          console.error("Could not copy text: ", err);
        }
      );
    },
    [fgRef]
  );

  useEffect(() => {
    if (isFullScreen) {
      setGraphWidth(window.innerWidth);
      setGraphHeight(window.innerHeight);
    } else {
      setGraphWidth(width);
      setGraphHeight(height);
    }
  }, [isFullScreen, width, height]);

  const handleResetView = () => {
    if (!fgRef.current || !graphData?.nodes?.length) return;

    // Calculate bounding box of all nodes
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

    // Look at the calculated center from the calculated distance
    fgRef.current.cameraPosition(
      { x: centerX, y: centerY, z: centerZ + distance }, // position camera at the calculated distance
      { x: centerX, y: centerY, z: centerZ }, // look at the center of the graph
      3000 // duration of the transition (in ms)
    );
  };

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
        nodeLabel={(node: NodeObject) =>
          `<span style="color: ${labelColor}">${node.label || node.id}</span>`
        }
        linkLabel={(d: LinkObject) => `<span style="color: ${labelColor}">${d.label}</span>`}
        linkDirectionalArrowLength={7}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.3}
        linkOpacity={0.5}
        linkWidth={5}
        backgroundColor={switchOn ? "#ffffff" : "#000000"}
        nodeThreeObject={({ group }) => {
          const geometry =
            group === "" ? new THREE.BoxGeometry(8, 8, 8) : new THREE.SphereGeometry(5);

          const material = new THREE.MeshStandardMaterial({
            color: getGroupColor(group),
            roughness: 0.7,
          });

          return new THREE.Mesh(geometry, material);
        }}
        onNodeClick={handleClick}
      />
      <FullScreenButton isFullScreen={isFullScreen} setIsFullScreen={setIsFullScreen} />
      <ResetViewButton resetView={handleResetView} />
      <ThemeSwitch switchOn={switchOn} setSwitchOn={setSwitchOn} />
      <Legend />
    </Box>
  );
};

export default Graph;
