import * as rdflib from "rdflib";
import { GraphData, LinkObject, NodeObject } from "react-force-graph-3d";
import CONFIG from "./config.ts";
import { GroupType } from "./vite-env";

const getGroupColor = (group: string) => {
  for (const g of CONFIG.groups) {
    if (g.name === group) {
      return g.color;
    }
  }
  return "gray";
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
    const color = getGroupColor(safeGroup);
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
        color: node?.color,
      };
      updatedNode.color = getGroupColor(updatedNode.group ?? "");

      nodesMap.set(id, updatedNode);
    }
  };

  store.statements.forEach((statement) => {
    const subj = statement.subject.value;
    const pred = statement.predicate.value;
    const obj = statement.object.value;

    // If the predicate is in the ignored list, skip this statement

    if (
      !(
        CONFIG.relevantProperties &&
        CONFIG.relevantProperties.size > 0 &&
        (CONFIG.relevantProperties.has(pred) ||
          pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type")
      )
    ) {
      return; // Skip this statement
    }

    // set node type
    if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") {
      if (CONFIG.skipTypes?.includes(obj)) {
        return;
      }
      const group = typeToGroup(obj);

      if (group === "") {
        return;
      }

      safeUpdateElement(subj, undefined, group);
    } else if (pred in CONFIG.labelProperties) {
      const label = statement.object.value;

      safeUpdateElement(subj, label);
    }

    // Create links for relevant relationships
    const includesElement = CONFIG.relationProperties.some((item: string) => pred.includes(item));
    if (includesElement) {
      const isLiteral = statement.object.termType === "Literal";
      
      if (!isLiteral) {
        const group = predToGroup(pred);
        if (group !== "") {
          safeUpdateElement(obj, undefined, group);
        }
        // Only create node for edge targets if not already in map (let type statements handle it)
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
  for (const group of CONFIG.groups) {
    if (group.types.includes(type)) {
      return group.name;
    }
  }
  return "";
};

const predToGroup = (pred: string): string => {
  for (const group of CONFIG.groups) {
    if (group.properties && group.properties.includes(pred)) {
      return group.name;
    }
  }
  return "";
};

// config groups keys
const groups = CONFIG.groups.map((group: GroupType) => group.name);

export { createGraph, rdfGraphToNodes, removeNonConnectedNodes, groups, getGroupColor };
