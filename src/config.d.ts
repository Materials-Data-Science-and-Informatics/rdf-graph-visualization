export type GroupType = {
  name: string;
  types: string[];
  properties?: string[];
  color: string;
};

export type ConfigType = {
  relevantProperties: string[];
  relationProperties: string[];
  labelProperties: string[];
  groups: Group[];
};
