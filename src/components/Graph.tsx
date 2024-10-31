import * as React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { groupColors, getGroupColor } from "../utils";
import FullScreenButton from "./FullScreenButton.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnimationStageType,
  zoomedOutedRotationAnimation,
  humanZoomedInRotationAnimation,
  miningZoomedInRotationAnimation,
} from "./animation";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
  isAnimating1: boolean;
  isAnimating2: boolean;
  isAnimating3: boolean;
}

const Graph: React.FC<GraphProps> = ({
  graphData,
  width,
  height,
  isAnimating1,
  isAnimating2,
  isAnimating3,
}) => {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [graphWidth, setGraphWidth] = useState(width);
  const [graphHeight, setGraphHeight] = useState(height);
  const [stageIndex, setStageIndex] = useState(0);
  const [stages, setStages] = useState<AnimationStageType[]>([]);

  const fgRef = useRef<any>(null);
  const animationId = useRef<number>();

  const handleClick = useCallback(
    (node: NodeObject) => {
      if (!node || node.x === undefined || node.y === undefined || node.z === undefined) return;
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

  const animateStage = useCallback(
    (stage: AnimationStageType) => {
      if (!fgRef.current) return;

      const cameraPosition = (
        position: { x: number; y: number; z: number },
        lookAt: { x: number; y: number; z: number },
        duration: number
      ) => {
        fgRef.current.cameraPosition(position, lookAt, duration * 1000);
      };

      if (stage.type === "zoomIn") {
        let position = { x: 0, y: 0, z: 0 };
        if (stage.nodeId) {
          const targetNode = graphData.nodes.find((node) => node.id === stage.nodeId);
          if (
            targetNode &&
            targetNode.x !== undefined &&
            targetNode.y !== undefined &&
            targetNode.z !== undefined
          ) {
            position = { x: targetNode.x , y: targetNode.y  , z: targetNode.z   };
          }
        } else if (stage.position) {
          position = stage.position;
        }
        // set camera like rotate but dont rotate ofc
        const distance = stage.distance || 300;
        cameraPosition({x:position.x+distance, y:position.y,z:position.z}, position, stage.duration ?? 0);
      } else if (stage.type === "rotate") {
        let rotateAround = { x: 0, y: 0, z: 0 };
        if (stage.nodeId) {
          const targetNode = graphData.nodes.find((node) => node.id === stage.nodeId);
          if (targetNode) rotateAround = { x: targetNode.x, y: targetNode.y, z: targetNode.z };
        } else if (stage.position) {
          rotateAround = stage.position;
        }

        const radius = stage.distance || 300;
        const duration = stage.duration * 1000;
        const startTime = Date.now();
        const rotationAngle = Math.PI / 4;

        const rotate = () => {
          const elapsedTime = Date.now() - startTime;
          if (elapsedTime  >= duration) return;

          const angle = (rotationAngle * elapsedTime) / duration;
          const x = rotateAround.x + radius * Math.cos(angle);
          const z = rotateAround.z + radius * Math.sin(angle);

          fgRef.current.cameraPosition(
            { x, y: rotateAround.y, z },
            { x: rotateAround.x, y: rotateAround.y, z: rotateAround.z },
            0
          );

          animationId.current = requestAnimationFrame(rotate);
        };
        rotate();
      }
    },
    [graphData]
  );

  useEffect(() => {
    // Select the appropriate animation stages based on the active isAnimating flag
    if (isAnimating1) {
      setStages(zoomedOutedRotationAnimation);
      setStageIndex(0);
    } else if (isAnimating2) {
      setStages(humanZoomedInRotationAnimation);
      setStageIndex(0);
    } else if (isAnimating3) {
      setStages(miningZoomedInRotationAnimation);
      setStageIndex(0);
    } else {
      setStages([]); // Reset stages if no animation flag is active
    }
  }, [isAnimating1, isAnimating2, isAnimating3]);

  // useEffect(() => {
  //   if (stages.length > 0 && stageIndex < stages.length) {
  //     animateStage(stages[stageIndex]);
  //     const { duration } = stages[stageIndex];
  //     const timeoutId = setTimeout(() => {
  //       setStageIndex((prevStageIndex) => prevStageIndex + 1);
  //     }, duration * 1000);
  //
  //     return () => clearTimeout(timeoutId);
  //   } else if (stageIndex >= stages.length) {
  //     setStageIndex(0);
  //   }
  //   return () => {
  //     if (animationId.current) cancelAnimationFrame(animationId.current);
  //   };
  // }, [stages, stageIndex, animateStage]);
  useEffect(() => {
    if (stages.length > 0) {
      const animateNextStage = (currentStageIndex: number) => {
        if (currentStageIndex >= stages.length) {
          setStageIndex(0); // Reset to the beginning or stop if desired
          return;
        }

        // Animate the current stage
        animateStage(stages[currentStageIndex]);

        const duration = stages[currentStageIndex].duration * 1000; // Stage duration in milliseconds
        const startTime = Date.now();

        // Transition loop for smooth movement
        const transition = () => {
          const elapsed = Date.now() - startTime;

          if (elapsed < duration) {
            animationId.current = requestAnimationFrame(transition);
          } else {
            // Move to the next stage after current stage duration has passed
            setStageIndex((index) => index + 1);
          }
        };

        animationId.current = requestAnimationFrame(transition);
      };

      animateNextStage(stageIndex);
    }

    // Cleanup
    return () => {
      if (animationId.current) cancelAnimationFrame(animationId.current);
    };
  }, [stageIndex, stages, animateStage]);

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
