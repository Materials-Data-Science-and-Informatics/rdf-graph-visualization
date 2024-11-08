import { Flex, IconButton } from "@chakra-ui/react";
import * as React from "react";
import { GrPowerReset } from "react-icons/gr";

interface ResetViewButtonProps {
  resetView: () => void;
}

const ResetViewButton: React.FC<ResetViewButtonProps> = ({ resetView }) => {
  return (
    <Flex position="absolute" top="60px" left="10px" padding="10px" flexDirection="column">
      <IconButton aria-label="Toggle full screen" icon={<GrPowerReset />} onClick={resetView} />
    </Flex>
  );
};

export default ResetViewButton;
