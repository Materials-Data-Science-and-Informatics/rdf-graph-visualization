import { Box, Flex, useBreakpointValue } from "@chakra-ui/react";
import { ReactNode } from "react";
import Navbar from "./Navbar";
import Footer from "./Footer";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const contentWidth = useBreakpointValue({
    base: "95%", // for screens smaller than 720px
    md: "85%", // for screens between 720px and 1080px
    xl: "75%", // for screens larger than 1080px
  });

  return (
    <Flex minHeight="100vh" flexDirection="column" width="100%" overflowX="hidden">
      <Navbar />
      <Box
        as="main"
        flex="1"
        width={contentWidth}
        mx="auto"
        justifyContent="center"
        overflowX="hidden"
      >
        {children}
      </Box>
      <Footer />
    </Flex>
  );
}
