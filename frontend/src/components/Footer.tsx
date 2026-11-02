import { Box, Flex, Link, Text, UnorderedList, ListItem } from "@chakra-ui/react";
import { FaLinkedin, FaMastodon, FaTwitter, FaEnvelope, FaGithub } from "react-icons/fa";
import { version } from "../../package.json";

type IconType = "linkedin" | "mastodon" | "x" | "mattermost" | "mail";

const Footer = () => {
  const contact: { type: IconType; link: string }[] = [
    {
      type: "linkedin",
      link: "https://www.linkedin.com/company/helmholtz-metadata-collaboration-hmc/",
    },
    { type: "mastodon", link: "https://helmholtz.social/@helmholtz_hmc" },
    { type: "x", link: "https://x.com/helmholtz_hmc" },
    { type: "mattermost", link: "https://mattermost.hzdr.de/hmc-public" },
    { type: "mail", link: "mailto:m.soylu@fz-juelich.de" },
  ];

  const iconComponents: Record<IconType, JSX.Element> = {
    linkedin: <FaLinkedin />,
    mastodon: <FaMastodon />,
    x: <FaTwitter />,
    mattermost: <FaGithub />,
    mail: <FaEnvelope />,
  };

  return (
    <Box as="footer" bg="rgb(0, 40, 100)" color="white" px={{ base: 4, md: 6 }} pt={4} pb={4} mt={4}>
      <Flex direction="column" mb={3} px={3}>
        <Flex
          justifyContent="space-between"
          alignItems={{ base: "flex-start", md: "center" }}
          direction={{ base: "column", md: "row" }}
          gap={4}
          mb={4}
        >
          <Link href="https://helmholtz.de" target="_blank" aria-label="Open Helmholtz page">
            <svg xmlns="http://www.w3.org/2000/svg" width="200" height="28" fill="none">
              <path
                fill="#fff"
                d="M14.498 0h5.205v27.286h-5.205V16.28H5.202v11.005H0V0h5.202v11.043h9.296V0Zm13.598 0a.879.879 0 0 0-.613.273L25.8 1.965a.766.766 0 0 0-.271.614v22.128a.773.773 0 0 0 .27.617l1.683 1.692a.765.765 0 0 0 .613.273h14.538v-5.237h-11.9v-5.77h10.332v-5.24H30.735V5.234h11.9V0h-14.54Zm22.37 27.286h12.097v-5.234h-9.459V0h-5.202v24.707a.758.758 0 0 0 .271.617l1.684 1.692a.767.767 0 0 0 .613.273l-.003-.003Zm50.98-16.243V0h-5.203v27.286h5.203V16.28h9.295v11.005h5.206V0h-5.206v11.043h-9.295Zm34.613 8.458a.983.983 0 0 1-.271.617l-1.644 1.653a.894.894 0 0 1-.651.273h-4.651a.807.807 0 0 1-.614-.273l-1.643-1.653a.824.824 0 0 1-.272-.617V7.811a.778.778 0 0 1 .272-.616l1.643-1.691a.981.981 0 0 1 .614-.273h4.668c.241.015.47.111.651.273l1.643 1.691a.903.903 0 0 1 .272.617l-.017 11.69Zm1.224-18.205A4.437 4.437 0 0 0 134.223 0h-6.081a4.355 4.355 0 0 0-3.098 1.307l-2.68 2.696a4.374 4.374 0 0 0-1.264 3.091v13.098a4.382 4.382 0 0 0 1.261 3.08l2.68 2.729a4.273 4.273 0 0 0 3.101 1.285h6.081a4.33 4.33 0 0 0 3.06-1.269l2.712-2.729a4.375 4.375 0 0 0 1.267-3.097V7.095a4.38 4.38 0 0 0-1.261-3.078l-2.713-2.695-.005-.025Zm11.582 25.99h12.314v-5.234h-9.675V0h-5.202v24.707a.75.75 0 0 0 .271.617l1.684 1.692a.767.767 0 0 0 .613.273l-.005-.003Zm18.173-22.053v22.053h5.203V5.233h7.19V0H159.85v5.233h7.188Zm31.023-4.96a.894.894 0 0 0-.616-.273h-15.19v5.233h10.752L181.761 23.13v1.577a.913.913 0 0 0 .272.617l1.684 1.692a.767.767 0 0 0 .613.273h15.532v-5.237h-11.254L200 3.924V2.576a.911.911 0 0 0-.271-.614l-1.668-1.69ZM85.255 0l-7.237 12.609L70.778 0h-4.977v27.286h5.203V10.409l4.673 8.145a.87.87 0 0 0 .752.437h3.181a.861.861 0 0 0 .752-.437l4.633-8.068v16.8h5.202V0h-4.942Z"
              ></path>
            </svg>
          </Link>
          <Text fontSize="lg" ml={{ base: 0, md: 4 }}>
            Research for grand challenges.
          </Text>
        </Flex>

        <Flex mb={4}>
          <UnorderedList display="flex" flexWrap="wrap" gap={4} listStyleType="none" ml={0}>
            {contact.map((item, index) => (
              <ListItem key={index}>
                <Link
                  href={item.link}
                  isExternal
                  display="flex"
                  alignItems="center"
                  fontSize="1.5rem"
                >
                  {iconComponents[item.type]}
                </Link>
              </ListItem>
            ))}
          </UnorderedList>
        </Flex>

        <Flex
          justifyContent="space-between"
          alignItems={{ base: "flex-start", md: "center" }}
          direction={{ base: "column", md: "row" }}
          gap={3}
        >
          <UnorderedList display="flex" flexWrap="wrap" listStyleType="none" gap={4} ml={0}>
            <ListItem>
              <Link href="https://www.fz-juelich.de/en/legal-notice" isExternal>
                Imprint
              </Link>
            </ListItem>

            <ListItem>
              <Link href="mailto:m.soylu@fz-juelich.de" isExternal>
                Contact
              </Link>
            </ListItem>
          </UnorderedList>
          <Text>RDF Graph Visualization v{version}</Text>
          <Text>&copy; {new Date().getFullYear()} Forschungszentrum Jülich</Text>
        </Flex>
      </Flex>
    </Box>
  );
};

export default Footer;
