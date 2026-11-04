import { Button } from "@/components/ui/button";
import * as React from "react";
import { GrPowerReset } from "react-icons/gr";

interface ResetViewButtonProps {
  resetView: () => void;
}

const ResetViewButton: React.FC<ResetViewButtonProps> = ({ resetView }) => {
  return (
    <div className="absolute top-[60px] left-[10px] p-[10px]">
      <Button variant="outline" size="icon" aria-label="Reset view" onClick={resetView}>
        <GrPowerReset />
      </Button>
    </div>
  );
};

export default ResetViewButton;
