import * as rdflib from "rdflib";
import { Node, Link, GraphData } from "./components/Graph.tsx";

const createGraph = (rdfData: string, baseUrl: string): rdflib.Store => {
  const store = rdflib.graph();
  const base = rdflib.sym(baseUrl);

  try {
    rdflib.parse(rdfData, store, base.uri, "text/turtle");
  } catch (e) {
    console.error(e);
    console.log("Parsing TTL failed, trying RDF/XML...");
    rdflib.parse(rdfData, store, base.uri, "application/rdf+xml");
  }
  return store;
};

const rdfGraphToNodes = (store: rdflib.Store, removeUnconnectedNodes: boolean): GraphData => {
  const nodesMap = new Map<string, Node>();
  const edges: Link[] = [];

  const safeUpdateElement = (id: string, label?: string, group?: string): void => {
    if (!nodesMap.has(id)) {
      // create the node
      const newNode = { id: id, label: label ?? id, group: group ?? "" };

      nodesMap.set(id, newNode);
    } else {
      // get the node
      const node = nodesMap.get(id);
      const updatedNode = {
        id: id,
        label: label ?? node.label,
        group: group ?? node.group,
      };

      nodesMap.set(id, updatedNode);
    }
  };

  store.statements.forEach((statement) => {
    const subj = statement.subject.value;
    const pred = statement.predicate.value;
    const obj = statement.object.value;

    // set node type
    if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") {
      const group = typeToGroup(obj);

      safeUpdateElement(subj, undefined, group);
    } else if (pred === "http://schema.org/name" || pred === "http://schema.org/text") {
      // Check for schema:name, foaf:name, rdfs:label, etc.
      const label = statement.object.value;

      safeUpdateElement(subj, label);
    } else {
      safeUpdateElement(subj);
      safeUpdateElement(obj);
    }

    // Create links for relevant relationships
    const relationProperties = [
      "provider",
      "license",
      "keywords",
      // "identifier",
      "dataPublished",
      "dateModified",
      "creator",
      "author",
      "publisher",
      "affiliation",
    ];
    const includesElement = relationProperties.some((item) => pred.includes(item));
    if (includesElement) {
      if (pred.includes("affiliation")) {
        safeUpdateElement(obj, undefined, "organization");
      }
      if (pred.includes("author") || pred.includes("creator")) {
        safeUpdateElement(obj, undefined, "person");
      }
      if (!nodesMap.has(subj)) {
        nodesMap.set(subj, { id: subj, label: subj, group: "" });
      }
      edges.push({ source: subj, target: obj, label: pred });
    }
  });

  const nodes = Array.from(nodesMap.values());
  const graphData: GraphData = { nodes, links: edges };
  console.log(graphData);
  // return graphData;
  const connectedNodes = removeNonConnectedNodes(graphData);
  console.log("only connected nodes", connectedNodes);
  if (removeUnconnectedNodes) return { nodes: connectedNodes, links: edges };
  else return graphData;
};

const removeNonConnectedNodes = (graphData: GraphData): Node[] => {
  const connectedNodeIds = new Set(
    graphData.links.flatMap((edge: Link) => [edge.source, edge.target])
  );

  // Keep only nodes that are connected by edges
  return graphData.nodes.filter((node: Node) => connectedNodeIds.has(node.id));
};

const typeToGroup = (type: string): string => {
  const typeMap: Map<string, string> = new Map<string, string>();
  //schema:Person, schema:Organization, schema:Dataset, schema:SoftwareSourceCode, schema:Document,
  // schema:Article, schema:creativeWork, schema:Service

  // set types
  typeMap.set("person", "Person");
  typeMap.set("dataset", "Dataset");
  typeMap.set("organization", "Organization");
  typeMap.set("software", "SoftwareSourceCode");
  typeMap.set("document", "Document");
  typeMap.set("article", "Article");
  typeMap.set("creativeWork", "CreativeWork");
  typeMap.set("service", "Service");

  // iterate over the entries of the typeMap
  for (const [key, value] of typeMap.entries()) {
    // check if type input contains any of the elements in the values array
    if (type.toLowerCase().includes(value.toLowerCase())) {
      return key; // return the map key if a match is found
    }
  }

  return ""; // return a default value if no match is found
};
export { createGraph, rdfGraphToNodes };
