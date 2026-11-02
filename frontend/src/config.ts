import configFile from "/config.yml?raw";
import * as yaml from "js-yaml";
import { ConfigType } from "./vite-env";

const config: ConfigType = yaml.load(configFile) as ConfigType;

// set relevant properties from relationProperties, labelProperties, and groups' properties
const relevantProperties = new Set<string>();
config.relationProperties.forEach((prop) => relevantProperties.add(prop));
config.labelProperties.forEach((prop) => relevantProperties.add(prop));
config.groups.forEach((group) => {
  group.properties?.forEach((prop) => relevantProperties.add(prop));
});
config.relevantProperties = relevantProperties;

export default config;
