import React, { useState, useEffect } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from 'three';
import { GraphData, Node } from "./graph";
import { createGraph, rdfGraphToNodes } from "./utils.ts";

const Graph: React.FC = () => {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });

  // Function to load and parse the RDF file
  const loadAndParseRDF = async (fileUrl: string, callback: (data: GraphData) => void) => {
    const response = await fetch(fileUrl);
    const rdfData = await response.text();
    const store = createGraph(rdfData, "http://schema.org/");
    const graphData = rdfGraphToNodes(store);
    callback(graphData);
  };

  const getGroupColor = (group: string) => {
    // const colors: { [key: string]: number } = {
    //   person: 0,
    //   dataset: 1,
    //   organization: 2,
    //   software: 3,
    //   document: 4,
    //   article: 5,
    //   creativeWork: 6,
    //   service: 7,
    //   "": 8, // Default group
    // };
    const colors: { [key: string]: string } = {
      person: 'red',
      dataset: 'blue',
      organization: 'green',
      software: 'yellow',
      document: 'orange',
      article: 'indigo',
      creativeWork: 'violet',
      service: 'cyan',
      "": 'gray', // Default group
    };
    return colors[group] || 'gray'; // Default to 3 if group not found
  };

  useEffect(() => {
    // loadAndParseRDF("/data/dataset_juelichdata.ttl", setGraphData);
    loadAndParseRDF("/data/Helmholtz_KG-sample.ttl", setGraphData);
    // loadAndParseRDF("/data/software_rodare.ttl", setGraphData);
  }, []);

  const getNodeById = (id: string) => graphData.nodes.find((node: Node) => node.id === id);

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
      nodeLabel={(d) => `${(d as Node).label || (d as Node).id}`} // Show the label or fallback to id
      linkLabel={(d) => `${(d as Link).label}`} // Show the label for links
      linkDirectionalArrowLength={2.5}
      linkDirectionalArrowRelPos={1}
      linkCurvature={0.2}
      nodeThreeObject={({ group }) => {
        // Use box geometry for nodes with empty group, otherwise use spheres
        const geometry =
          group === ""
            ? new THREE.BoxGeometry(8, 8, 8) // Box for nodes with empty group
            : new THREE.SphereGeometry(5);    // Sphere for other nodes

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
