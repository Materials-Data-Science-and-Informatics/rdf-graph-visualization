import { Flex, Box, Text } from "@chakra-ui/react";
import * as React from "react";
import { FALLBACK_COLOR, getPaletteEntries } from "../config";

/**
 * Palette legend (card C4): entries come from the runtime /api/config
 * palette (module registry), not a build-time YAML import. The trailing
 * "Default" row is the code-side fallback colour for groups absent from the
 * config (e.g. "Unknown").
 */
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
      {getPaletteEntries().map(({ group, color }) => (
        <Flex key={group} alignItems="center" marginBottom="5px" flexDirection="row">
          <Box width="12px" height="12px" backgroundColor={color} marginRight="8px" />
          <Text fontSize="sm" textTransform="capitalize">
            {group}
          </Text>
        </Flex>
      ))}
      <Flex alignItems="center" marginBottom="5px" flexDirection="row">
        <Box width="12px" height="12px" backgroundColor={FALLBACK_COLOR} marginRight="8px" />
        <Text fontSize="sm" textTransform="capitalize">
          Default
        </Text>
      </Flex>
    </Flex>
  );
};

export default Legend;
