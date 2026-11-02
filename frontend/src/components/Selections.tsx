import {
  Box,
  Checkbox,
  HStack,
  Button,
  Text,
  Alert,
  AlertIcon,
  AlertTitle,
  AlertDescription,
} from "@chakra-ui/react";
import * as React from "react";
import { useState, Dispatch, SetStateAction, useEffect, useRef, useCallback } from "react";
import { getSubgraph, ApiError } from "../api/client";
import type { Page } from "../api/types";
import { subgraphToGraphData } from "../utils";
import { GraphData, LinkObject } from "react-force-graph-3d";
import LoadingSpinner from "./LoadingSpinner.tsx";

interface SelectionsProps {
  graphData: GraphData;
  setGraphData: Dispatch<SetStateAction<GraphData>>;
  setFilteredGraphData: Dispatch<SetStateAction<GraphData>>;
}

/**
 * Loads a bounded, cursor-paginated graph slice from the backend API as
 * typed JSON (contract: src/api/types.ts) and feeds it to the 3D graph.
 * Stale requests are aborted on re-fetch and on unmount.
 */
const Selections: React.FC<SelectionsProps> = ({
  graphData,
  setGraphData,
  setFilteredGraphData,
}: SelectionsProps) => {
  const [isChecked, setIsChecked] = useState<boolean>(false);
  const [filters, setFilters] = useState<Set<string>>(new Set<string>());
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  // The controller of the in-flight request; aborted on re-fetch/unmount.
  const abortRef = useRef<AbortController | null>(null);

  const loadSlice = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const slice = await getSubgraph({}, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setGraphData(subgraphToGraphData(slice));
      setPage(slice.page);
      setFilters(new Set<string>());
    } catch (err) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof ApiError
          ? `${err.kind === "timeout" ? "Timed out" : "Failed to load"}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setError(message);
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }, [setGraphData]);

  // Initial fetch + abort on unmount.
  useEffect(() => {
    void loadSlice();
    return () => {
      abortRef.current?.abort();
    };
  }, [loadSlice]);

  // Filter graph data based on selected groups and optionally remove unconnected nodes
  useEffect(() => {
    if (graphData.nodes.length === 0) {
      setFilteredGraphData({ nodes: [], links: [] });
      return;
    }

    let cancelled = false;

    const processFiltering = () => {
      if (cancelled) {
        return;
      }

      // Filter nodes by selected groups; if no filters, show all nodes
      const filteredNodes =
        filters.size === 0
          ? graphData.nodes
          : graphData.nodes.filter((node) => {
              const tempFilters = new Set(filters);
              if (filters.has("Default")) {
                tempFilters.delete("Default");
                tempFilters.add("");
              }
              return !tempFilters.has(node.group);
            });

      // Create a Set of node IDs for O(1) lookup
      const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));

      // Filter links to only include those connecting filtered nodes
      const filteredLinks = graphData.links.filter((link: LinkObject) => {
        const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
        const targetId = typeof link.target === "object" ? link.target?.id : link.target;
        return filteredNodeIds.has(sourceId) && filteredNodeIds.has(targetId);
      });

      let newGraphData: GraphData;
      if (!isChecked) {
        // Remove nodes that have no connections in the filtered view
        const connectedNodeIds = new Set(
          filteredLinks.flatMap((link) => {
            const sourceId = typeof link.source === "object" ? link.source?.id : link.source;
            const targetId = typeof link.target === "object" ? link.target?.id : link.target;
            return [sourceId, targetId];
          })
        );
        const connectedNodes = filteredNodes.filter((node) => connectedNodeIds.has(node.id));
        newGraphData = { nodes: connectedNodes, links: filteredLinks };
      } else {
        // Show all filtered nodes with all their links
        newGraphData = { nodes: filteredNodes, links: filteredLinks };
      }

      // ForceGraph mutates graph objects in place, so pass fresh copies on every UI-driven update.
      const graphSnapshot: GraphData = {
        nodes: newGraphData.nodes.map((node) => ({ ...node })),
        links: newGraphData.links.map((link) => ({
          ...link,
          source: typeof link.source === "object" ? link.source?.id : link.source,
          target: typeof link.target === "object" ? link.target?.id : link.target,
        })),
      };

      setFilteredGraphData(graphSnapshot);
    };

    if (graphData.nodes.length > 500) {
      const timeout = window.setTimeout(processFiltering, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timeout);
      };
    }

    processFiltering();

    return () => {
      cancelled = true;
    };
  }, [isChecked, filters, graphData, setFilteredGraphData]);

  const handleCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setIsChecked(event.target.checked);
  };

  if (loading) {
    return <LoadingSpinner />;
  }

  return (
    <Box p={4} width="100%" mx="auto">
      <HStack spacing={4} alignItems="center">
        <Button colorScheme="blue" onClick={() => void loadSlice()} isLoading={loading}>
          Load slice
        </Button>
        <Text mt={2} color="gray.500" fontSize="sm">
          {page
            ? `Bounded slice: limit ${page.limit}${page.truncated ? ", truncated" : ""}`
            : "No slice loaded yet"}
        </Text>
        <Checkbox isChecked={isChecked} onChange={handleCheckboxChange}>
          Add not connected nodes
        </Checkbox>
      </HStack>
      {error && (
        <Alert status="error" borderRadius="md" width="100%" mt={3} mb={3} mx="auto">
          <AlertIcon />
          <AlertTitle as="span">Could not load graph slice</AlertTitle>
          <AlertDescription as="span" data-testid="slice-error">
            {error}
          </AlertDescription>
        </Alert>
      )}
    </Box>
  );
};

export default Selections;
