import { Box, Spinner } from "@chakra-ui/react";

function LoadingSpinner() {
  return (
    <Box
      position="fixed"
      top="0"
      left="0"
      width="100vw"
      height="100vh"
      display="flex"
      alignItems="center"
      justifyContent="center"
      backgroundColor="rgba(0, 0, 0, 0.5)"
      zIndex="9999"
    >
      <Spinner size="xl" thickness="4px" speed="0.65s" color="blue.500" />
    </Box>
  );
}

export default LoadingSpinner;
