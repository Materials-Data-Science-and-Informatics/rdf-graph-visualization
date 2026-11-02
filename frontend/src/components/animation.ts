export type AnimationStageTypeType = "zoomIn" | "rotate";

export type PositionType = {
  x: number;
  y: number;
  z: number;
};

export type AnimationStageType = {
  type: AnimationStageTypeType;
  duration: number; //seconds
  position?: PositionType;
  nodeId?: string;
  distance?: number;
};
