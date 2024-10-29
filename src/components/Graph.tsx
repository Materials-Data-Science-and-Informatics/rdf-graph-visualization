import * as React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { groupColors, getGroupColor } from "./utils";
import FullScreenButton from "./FullScreenButton.tsx";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
}

const Graph: React.FC<GraphProps> = ({ graphData, width, height }) => {
  const [isFullScreen, setIsFullScreen] = React.useState(false);
  const [graphWidth, setGraphWidth] = React.useState(width);
  const [graphHeight, setGraphHeight] = React.useState(height);
  const getNodeById = (id: string) => graphData.nodes.find((node: NodeObject) => node.id === id);

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
        graphData={graphData}
        width={graphWidth}
        height={graphHeight}
        nodeAutoColorBy={(d) => getGroupColor(d.group || "")}
        linkAutoColorBy={(d) => {
          const sourceNode =
            typeof d.source === "object" ? d.source : getNodeById(d.source?.toString() ?? "");
          return getGroupColor(sourceNode?.group || "");
        }}
        nodeLabel={(d) => `${(d as NodeObject).label || (d as NodeObject).id}`} // Show the label or fallback to id
        linkLabel={(d) => `${(d as LinkObject).label}`} // Show the label for links
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
      />
      <FullScreenButton isFullScreen={isFullScreen} setIsFullScreen={setIsFullScreen} />
      <Legend groupColors={groupColors} />
    </Box>
  );
};

export default Graph;
