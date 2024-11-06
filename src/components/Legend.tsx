import { Flex, Box, Text } from "@chakra-ui/react";
import * as React from "react";
import CONFIG from "../config.ts";
import { GroupType } from "../vite-env";

const Legend: React.FC = () => {
  return (
    <Flex
      position="absolute"
      top="10px"
      right="10px"
      backgroundColor="white"
      padding="10px"
      borderRadius="8px"
      boxShadow="md"
      flexDirection="column"
    >
      {CONFIG.groups.map((group: GroupType) => (
        <Flex key={group.name} alignItems="center" marginBottom="5px" flexDirection="row">
          <Box width="12px" height="12px" backgroundColor={group.color} marginRight="8px" />
          <Text fontSize="sm" textTransform="capitalize">
            {group.name}
          </Text>
        </Flex>
      ))}
      <Flex alignItems="center" marginBottom="5px" flexDirection="row">
        <Box width="12px" height="12px" backgroundColor="gray" marginRight="8px" />
        <Text fontSize="sm" textTransform="capitalize">
          Default
        </Text>
      </Flex>
    </Flex>
  );
};

export default Legend;
