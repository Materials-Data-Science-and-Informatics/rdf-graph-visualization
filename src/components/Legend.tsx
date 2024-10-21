import { Flex, Box, Text } from "@chakra-ui/react";
import * as React from "react";

interface LegendProps {
  groupColors: { [key: string]: string };
}

const Legend: React.FC<LegendProps> = ({ groupColors }) => {
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
      {Object.keys(groupColors).map((group: string) => (
        <Flex key={group} alignItems="center" marginBottom="5px" flexDirection="row">
          <Box width="12px" height="12px" backgroundColor={groupColors[group]} marginRight="8px" />
          <Text fontSize="sm" textTransform="capitalize">
            {group || "Default"}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
};

export default Legend;
