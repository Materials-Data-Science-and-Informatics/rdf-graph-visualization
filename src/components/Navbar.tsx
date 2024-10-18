import { Box, Flex, Text } from "@chakra-ui/react";

const Navbar = () => {
  return (
    <Box bg={"green.100"} px={4} mb={5}>
      <Flex h={16} alignItems={"center"} justifyContent={"center"}>
        <Text fontSize="xl" fontWeight="bold" color="green.800">
          RDF Graph Visualization
        </Text>
      </Flex>
    </Box>
  );
};
export default Navbar;
