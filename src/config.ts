import configFile from "/config.yml?raw";
import * as yaml from "js-yaml";
import { ConfigType } from "./vite-env";

const config: ConfigType = yaml.load(configFile) as ConfigType;

// relevant properties should be a Set of strings
config.relevantProperties = new Set(config.relevantProperties);

export default config;
