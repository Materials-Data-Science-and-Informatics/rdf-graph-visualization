import { Box, Flex, Text, Image, Link, Stack } from "@chakra-ui/react";
import { ExternalLinkIcon } from "@chakra-ui/icons";

interface NavbarProps {
  onInfoClick: () => void;
  onConfigClick: () => void;
}

const Navbar = ({ onInfoClick, onConfigClick }: NavbarProps) => {
  return (
    <Box bg={"#3eb8fc"} px={{ base: 4, md: 8 }} py={3} mb={4}>
      <Flex
        alignItems={{ base: "flex-start", lg: "center" }}
        justifyContent={"space-between"}
        direction={{ base: "column", lg: "row" }}
        gap={4}
      >
        <Image
          src="https://github.com/Materials-Data-Science-and-Informatics/Logos/blob/main/HelmholtzKG/Logo_HelmholtzKG_notext_brightback.png?raw=true"
          alt="Logo"
          h={12}
          cursor="pointer"
          onClick={() => window.location.reload()}
        />
        <Text fontSize={{ base: "lg", md: "xl" }} fontWeight="bold" color="whiteAlpha.900">
          RDF Graph Visualization
        </Text>
        <Stack
          direction={{ base: "column", sm: "row" }}
          spacing={4}
          align={{ base: "stretch", sm: "center" }}
          width={{ base: "100%", lg: "auto" }}
        >
          <Link
            href="#info"
            color={"white"}
            fontSize={{ base: "md", md: "xl" }}
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
            fontSize={{ base: "md", md: "xl" }}
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
            fontSize={{ base: "md", md: "xl" }}
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
