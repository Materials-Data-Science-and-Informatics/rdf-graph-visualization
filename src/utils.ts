import * as rdflib from "rdflib";
import { GraphData, LinkObject, NodeObject } from "react-force-graph-3d";

const groupColors: { [key: string]: string } = {
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

const getGroupColor = (group: string) => {
  return groupColors[group] || "gray"; // Default to gray if group not found
};

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

const rdfGraphToNodes = (store: rdflib.Store): GraphData => {
  const nodesMap = new Map<string, NodeObject<NodeType>>();
  const edges: LinkObject<NodeType, LinkType>[] = [];

  // create the element if not exists
  const safeUpdateElement = (id: string, label?: string, group?: string): void => {
    const safeGroup = group ?? "";
    const safeLabel = label ?? id;
    const color = group ? getGroupColor(safeGroup) : "gray";
    if (!nodesMap.has(id)) {
      // create the node
      const newNode = { id: id, label: safeLabel, group: safeGroup, color } as NodeType;

      nodesMap.set(id, newNode);
    } else {
      // get the node
      const node = nodesMap.get(id);
      const updatedNode = {
        id: id,
        label: label ?? node?.label,
        group: group ?? node?.group,
      };
      updatedNode.color = updatedNode.group ? getGroupColor(updatedNode.group) : "gray";

      nodesMap.set(id, updatedNode);
    }
  };

  store.statements.forEach((statement) => {
    const subj = statement.subject.value;
    const pred = statement.predicate.value;
    const obj = statement.object.value;

    // Filter out unwanted annotation properties and irrelevant predicates
    // List of relevant properties you care about
    const relevantProperties = new Set([
      "http://schema.org/name",
      "http://schema.org/text",
      "http://schema.org/affiliation",
      "http://schema.org/author",
      "http://schema.org/creator",
      "http://schema.org/license",
      "http://schema.org/keywords",
      "http://schema.org/provider",
      "http://schema.org/publisher",
      "http://schema.org/dateModified",
      "http://schema.org/datePublished",
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    ]);

    // If the predicate is in the ignored list, skip this statement
    if (!relevantProperties.has(pred)) {
      return; // Skip this statement
    }

    // set node type
    if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") {
      const group = typeToGroup(obj);

      if (group === "") {
        return;
      }

      safeUpdateElement(subj, undefined, group);
    } else if (pred === "http://schema.org/name" || pred === "http://schema.org/text") {
      // Check for schema:name, foaf:name, rdfs:label, etc.
      const label = statement.object.value;

      safeUpdateElement(subj, label);
    }

    // Create links for relevant relationships
    const relationProperties = [
      "provider",
      "license",
      "keywords",
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
      if (!nodesMap.has(obj)) {
        nodesMap.set(obj, { id: obj, label: obj, group: "" });
      }
      // set as source color, if not set target color, if not set default color gray
      const linkColor = nodesMap.get(subj)?.color ?? nodesMap.get(obj)?.color ?? "gray";
      edges.push({ source: subj, target: obj, label: pred, color: linkColor });
    }
  });

  const nodes = Array.from(nodesMap.values());
  return { nodes, links: edges } as GraphData;
};

const removeNonConnectedNodes = (graphData: GraphData): NodeObject[] => {
  // Collect all connected node ids from the links
  const connectedNodeIds = new Set(
    graphData.links.flatMap(({ source, target }) => {
      const sourceId =
        typeof source === "string" || typeof source === "number" ? source : source?.id; // Handle cases where source could be undefined or an object

      const targetId =
        typeof target === "string" || typeof target === "number" ? target : target?.id; // Handle cases where target could be undefined or an object

      // Only return IDs if sourceId and targetId are defined
      return [sourceId, targetId].filter((id) => id !== undefined);
    })
  );

  // Keep only nodes that are connected by edges
  return graphData.nodes.filter((node: NodeObject) =>
    connectedNodeIds.has(node?.id?.toString() ?? "")
  );
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

const groups = Object.keys(groupColors).filter((group) => group !== ""); // Remove the default group

export {
  createGraph,
  rdfGraphToNodes,
  removeNonConnectedNodes,
  groupColors,
  groups,
  getGroupColor,
};
