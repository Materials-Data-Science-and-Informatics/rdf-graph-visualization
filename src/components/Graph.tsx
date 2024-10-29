import * as React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { groupColors, getGroupColor } from "../utils";
import FullScreenButton from "./FullScreenButton.tsx";
import { useCallback, useEffect, useRef, useState } from "react";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
  isAnimating: boolean;
}

const Graph: React.FC<GraphProps> = ({ graphData, width, height, isAnimating }) => {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);
  const fgRef = useRef<any>(null);

  // For orbit animation
  const animationId = useRef<number>();
  const angleRef = useRef(0); // Track the angle for orbiting

  const handleClick = useCallback(
    (node: NodeObject) => {
      if (!node || node.x === undefined || node.y === undefined || node.z === undefined) {
        return;
      }
      if (!fgRef.current) return;

      const distance = 80;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);

      fgRef.current.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        node,
        2000
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

  // Orbit animation function
  const animateOrbit = useCallback(() => {
    if (!fgRef.current) return;

    angleRef.current += 0.01; // Increment angle for smooth orbit
    const distance = 300;

    // Calculate camera position based on angle
    const x = distance * Math.sin(angleRef.current);
    const z = distance * Math.cos(angleRef.current);
    const y = 100; // Optional: adjust for a slight elevation

    fgRef.current.cameraPosition(
      { x, y, z }, // New camera position
      { x: 0, y: 0, z: 0 }, // Look at center of graph
      0
    );

    // Request the next frame for smooth animation
    animationId.current = requestAnimationFrame(animateOrbit);
  }, []);

  // Toggle animation on/off
  useEffect(() => {
    if (isAnimating) {
      animateOrbit();
    } else if (animationId.current) {
      cancelAnimationFrame(animationId.current);
    }
    return () => {
      if (animationId.current) cancelAnimationFrame(animationId.current);
    };
  }, [isAnimating, animateOrbit]);

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
