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

const stages: AnimationStageType[] = [
  { type: "rotate", duration: 6, position: { x: 0, y: 0, z: 0 }, distance: 2000 },
  {
    type: "zoomIn",
    nodeId: "https://creativecommons.org/licenses/by/3.0",
    duration: 3,
    distance: 300,
  },
  {
    type: "rotate",
    nodeId: "https://creativecommons.org/licenses/by/3.0",
    duration: 5,
    distance: 600,
  },
  { type: "zoomIn", nodeId: "https://orcid.org/0000-0002-7527-7827", duration: 2, distance: 300 },
  { type: "rotate", nodeId: "https://orcid.org/0000-0002-7527-7827", duration: 5, distance: 600 },
  {
    type: "zoomIn",
    nodeId: "Global-scale mining polygons (Version 2)",
    duration: 2,
    distance: 300,
  },
  {
    type: "rotate",
    nodeId: "Global-scale mining polygons (Version 2)",
    duration: 5,
    distance: 600,
  },
  { type: "zoomIn", duration: 1, position: { x: 0, y: 1000, z: 1500 }, distance: 300 },
  { type: "rotate", duration: 4, position: { x: 0, y: 1000, z: 1500 }, distance: 300 },
];

const zoomedOutedRotationAnimation: AnimationStageType[] = [
  { type: "rotate", duration: 10, position: { x: 0, y: 0, z: 0 }, distance: 4000 },
];

const humanZoomedInRotationAnimation: AnimationStageType[] = [
  { type: "zoomIn", duration: 0, position: { x: 0, y: 0, z: 0 }, distance: 4000 },
  {
    type: "zoomIn",
    nodeId: "https://orcid.org/0000-0002-7527-7827",
    duration: 8,
    distance: 600,
  },
  {
    type: "rotate",
    nodeId: "https://orcid.org/0000-0002-7527-7827",
    duration: 10,
    distance: 600,
  },
];

const miningZoomedInRotationAnimation: AnimationStageType[] = [
  { type: "zoomIn", duration: 0, position: { x: 0, y: 0, z: 0 }, distance: 4000 },
  {
    type: "zoomIn",
    nodeId: "Global-scale mining polygons (Version 2)",
    duration: 5,
    distance: 900,
  },
  {
    type: "rotate",
    nodeId: "Global-scale mining polygons (Version 2)",
    duration: 10,
    distance: 900,
  },
];
export {
  stages,
  zoomedOutedRotationAnimation,
  humanZoomedInRotationAnimation,
  miningZoomedInRotationAnimation,
};
