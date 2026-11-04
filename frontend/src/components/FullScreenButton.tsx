import { Button } from "@/components/ui/button";
import * as React from "react";
import { RiFullscreenLine } from "react-icons/ri";
import { RiFullscreenExitLine } from "react-icons/ri";

interface FullScreenButtonProps {
  isFullScreen: boolean;
  setIsFullScreen: (isFullScreen: boolean) => void;
}

const FullScreenButton: React.FC<FullScreenButtonProps> = ({ isFullScreen, setIsFullScreen }) => {
  return (
    <div className="absolute top-[10px] left-[10px] p-[10px]">
      <Button
        variant="outline"
        size="icon"
        aria-label="Toggle full screen"
        onClick={() => setIsFullScreen(!isFullScreen)}
      >
        {isFullScreen ? <RiFullscreenExitLine /> : <RiFullscreenLine />}
      </Button>
    </div>
  );
};

export default FullScreenButton;
