import { Box, Flex, Text, Image, Link, Stack } from "@chakra-ui/react";
import { ExternalLinkIcon } from "@chakra-ui/icons";

interface NavbarProps {
  onInfoClick: () => void;
  onConfigClick: () => void;
}

const Navbar = ({ onInfoClick, onConfigClick }: NavbarProps) => {
  return (
    <Box bg={"#3eb8fc"} px={8} mb={5}>
      <Flex h={16} alignItems={"center"} justifyContent={"space-between"}>
        <Image
          src="https://github.com/Materials-Data-Science-and-Informatics/Logos/blob/main/HelmholtzKG/Logo_HelmholtzKG_notext_brightback.png?raw=true"
          alt="Logo"
          h={12}
          cursor="pointer"
          onClick={() => window.location.reload()}
        />
        <Text fontSize="xl" fontWeight="bold" color="whiteAlpha.900">
          RDF Graph Visualization
        </Text>
        <Stack direction="row" spacing={4} align="center">
          <Link
            href="#info"
            color={"white"}
            fontSize={"xl"}
            fontWeight={"bold"}
            border="1px solid white"
            px={3}
            py={1}
            borderRadius="md"
            onClick={(e) => { e.preventDefault(); onInfoClick(); }}
            display="inline-flex"
            alignItems="center"
          >
            Info
          </Link>
          <Link
            href="#config"
            color={"white"}
            fontSize={"xl"}
            fontWeight={"bold"}
            border="1px solid white"
            px={3}
            py={1}
            borderRadius="md"
            onClick={(e) => { e.preventDefault(); onConfigClick(); }}
            display="inline-flex"
            alignItems="center"
          >
            Config
          </Link>
          <Link
            href="https://www.helmholtz.de/en/"
            color={"white"}
            fontSize={"xl"}
            fontWeight={"bold"}
            border="1px solid white"
            px={3}
            py={1}
            borderRadius="md"
            isExternal
            display="inline-flex"
            alignItems="center"
          >
            HMC <ExternalLinkIcon mx="2px" />
          </Link>
        </Stack>
      </Flex>
    </Box>
  );
};

export default Navbar;
