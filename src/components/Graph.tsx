// Graph.tsx
import * as React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";
import { Box } from "@chakra-ui/react";
import Legend from "./Legend.tsx";
import { groupColors, getGroupColor } from "./utils";

interface GraphProps {
  graphData: GraphData;
  width: number;
  height: number;
}



const Graph: React.FC<GraphProps> = ({ graphData, width, height }) => {


  const getNodeById = (id: string) => graphData.nodes.find((node: NodeObject) => node.id === id);

  return (
    <Box width={width} height={height} position="relative">
      <ForceGraph3D
        graphData={graphData}
        width={width}
        height={height}
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
      <Legend groupColors={groupColors} />
    </Box>
  );
};

export default Graph;
