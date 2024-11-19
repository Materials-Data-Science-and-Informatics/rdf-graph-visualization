import { Box, Flex, Text, Image, Link } from "@chakra-ui/react";
import { ExternalLinkIcon } from "@chakra-ui/icons";

const Navbar = () => {
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
        <Link
          href="https://www.helmholtz.de/en/"
          color={"whiteAlpha.900"}
          fontSize={"xl"}
          fontWeight={"bold"}
          isExternal
        >
          HMC <ExternalLinkIcon mx="2px" />
        </Link>
      </Flex>
    </Box>
  );
};

export default Navbar;
