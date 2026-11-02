import { Alert, AlertDescription, AlertIcon, Button, Box, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import Content from "./components/Content.tsx";
import Layout from "./components/Layout.tsx";
import LoadingSpinner from "./components/LoadingSpinner.tsx";
import { loadConfig } from "./config";

type ConfigState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

/**
 * Card C4: the renderer config (palette, relation/label properties) is
 * fetched at runtime from /api/config — nothing is baked in at build time,
 * so a config change on the serving backend shows up without a frontend
 * rebuild. The UI mounts only once the config is in; a failed config fetch
 * is surfaced instead of rendering uncoloured/legless graph chrome.
 */
function App() {
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    loadConfig(controller.signal)
      .then(() => setConfigState({ status: "ready" }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setConfigState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, []);

  if (configState.status === "loading") {
    return <LoadingSpinner />;
  }

  if (configState.status === "error") {
    return (
      <Box p={8} maxW="640px" mx="auto" mt={12}>
        <Alert status="error" borderRadius="md">
          <AlertIcon />
          <Box flex="1">
            <Text fontWeight="bold">Could not load graph configuration</Text>
            <AlertDescription as="span" fontSize="sm" mt={1} data-testid="config-error">
              {configState.message}
            </AlertDescription>
          </Box>
        </Alert>
        <Button mt={4} colorScheme="blue" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </Box>
    );
  }

  return (
    <Layout>
      <Content />
    </Layout>
  );
}

export default App;
