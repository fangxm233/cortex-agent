import { loadGatewayConfig, type GatewayConfig } from './gateway-config.js';
import { CONFIG_DIR } from './paths.js';

// The port the gateway.yaml writers in gateway-generator still stamp into `port:`: the startup
// settings (process env, then config/.env, then the default). No gateway listens there any more;
// this goes with those writers.
const STARTUP_CONFIG = loadGatewayConfig(CONFIG_DIR);

export function activeGatewayConfig(): GatewayConfig {
  return STARTUP_CONFIG;
}
