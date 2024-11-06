/// <reference types="vite/client" />
export type GroupType = {
  name: string;
  types: string[];
  properties?: string[];
  color: string;
};

export type ConfigType = {
  relevantProperties?: Set<string>;
  relationProperties: string[];
  labelProperties: string[];
  groups: GroupType[];
};
