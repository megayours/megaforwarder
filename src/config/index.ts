import { OracleConfig } from "./OracleConfig";

const config = await OracleConfig.load(process.env.CONFIG_FILE || 'oracle.yaml');

export default config;