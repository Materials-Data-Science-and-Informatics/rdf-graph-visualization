import { Box, Flex, useBreakpointValue } from "@chakra-ui/react";
import { ReactNode } from "react";
import Navbar from "./Navbar";

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
    <Flex minHeight="100vh" display="flex" flexDirection="column" width="100vw">
      <Navbar />
      <Box flex="1" width={contentWidth} mx="auto" justifyContent="center">
        {/* Ensure the child component takes the full available space */}
        <Box height="100%" width="100%" display="flex" justifyContent="center" alignItems="center">
          {children}
        </Box>
      </Box>
      {/*<Footer />*/}
    </Flex>
  );
}
