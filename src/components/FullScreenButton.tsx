import { Flex, IconButton } from "@chakra-ui/react";
import * as React from "react";
import { RiFullscreenLine } from "react-icons/ri";
import { RiFullscreenExitLine } from "react-icons/ri";

interface FullScreenButtonProps {
  isFullScreen: boolean;
  setIsFullScreen: (isFullScreen: boolean) => void;
}

const FullScreenButton: React.FC<FullScreenButtonProps> = ({ isFullScreen, setIsFullScreen }) => {
  return (
    <Flex position="absolute" top="10px" left="10px" padding="10px" flexDirection="column">
      <IconButton
        aria-label="Toggle full screen"
        icon={isFullScreen ? <RiFullscreenExitLine /> : <RiFullscreenLine />}
        onClick={() => setIsFullScreen(!isFullScreen)}
      />
    </Flex>
  );
};

export default FullScreenButton;
