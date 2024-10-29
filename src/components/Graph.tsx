import * as React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { groupColors, getGroupColor } from "../utils";
import FullScreenButton from "./FullScreenButton.tsx";
import { useCallback, useRef, useState } from "react";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
}

const Graph: React.FC<GraphProps> = ({ graphData, width, height }) => {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);

  const fgRef = useRef();

  const handleClick = useCallback(
    (node) => {
      // Aim at node from outside it
      const distance = 80;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);

      fgRef.current.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio }, // new position
        node, // lookAt ({ x, y, z })
        2000 // ms transition duration
      );
    },
    [fgRef]
  );

  // Update graph dimensions when full screen is toggled
  React.useEffect(() => {
    if (isFullScreen) {
      setGraphWidth(window.innerWidth);
      setGraphHeight(window.innerHeight);
    } else {
      setGraphWidth(width);
      setGraphHeight(height);
    }
  }, [isFullScreen, width, height]);

  return (
    <Box
      width={isFullScreen ? "100vw" : width}
      height={isFullScreen ? "100vh" : height}
      position={isFullScreen ? "fixed" : "relative"}
      top={isFullScreen ? 0 : "unset"}
      left={isFullScreen ? 0 : "unset"}
      zIndex={isFullScreen ? 9999 : "auto"} // Ensure it covers everything in full screen
    >
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        width={graphWidth}
        height={graphHeight}
        nodeLabel={(node: NodeObject) => `${node.label || node.id}`}
        linkLabel={(d: LinkObject) => `${d.label}`}
        linkDirectionalArrowLength={7}
        linkDirectionalArrowRelPos={1}
        linkCurvature={0.3}
        linkOpacity={0.5}
        linkWidth={5}
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
      <Legend groupColors={groupColors} />
    </Box>
  );
};

export default Graph;
