import React from "react";
import ForceGraph3D, { GraphData, NodeObject, LinkObject } from "react-force-graph-3d";
import * as THREE from "three";

interface GraphProps {
  graphData: GraphData;
}

const Graph: React.FC<GraphProps> = ({ graphData }: GraphProps) => {
  const getGroupColor = (group: string) => {
    const colors: { [key: string]: string } = {
      person: "red",
      dataset: "blue",
      organization: "green",
      software: "yellow",
      document: "orange",
      article: "indigo",
      creativeWork: "violet",
      service: "cyan",
      "": "gray", // Default group
    };
    return colors[group] || "gray"; // Default to 3 if group not found
  };

  const getNodeById = (id: string) => graphData.nodes.find((node: NodeObject) => node.id === id);

  return (
    <ForceGraph3D
      graphData={graphData}
      nodeAutoColorBy={(d) => getGroupColor(d.group || "")}
      linkAutoColorBy={(d) => {
        const sourceNode =
          typeof d.source === "object" ? d.source : getNodeById(d.source?.toString() ?? "");
        return getGroupColor(sourceNode?.group || "");
      }}
      linkWidth={2}
      nodeLabel={(d) => `${(d as NodeObject).label || (d as NodeObject).id}`} // Show the label or fallback to id
      linkLabel={(d) => `${(d as LinkObject).label}`} // Show the label for links
      linkDirectionalArrowLength={2.5}
      linkDirectionalArrowRelPos={1}
      linkCurvature={0.2}
      nodeThreeObject={({ group }) => {
        // Use box geometry for nodes with empty group, otherwise use spheres
        const geometry =
          group === ""
            ? new THREE.BoxGeometry(8, 8, 8) // Box for nodes with empty group
            : new THREE.SphereGeometry(5); // Sphere for other nodes

        const material = new THREE.MeshStandardMaterial({
          color: getGroupColor(group),
          roughness: 0.7,
        });

        return new THREE.Mesh(geometry, material);
      }}
    />
  );
};

export default Graph;
