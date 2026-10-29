import { GATEWAY_CONFIG } from './paths.js';
import { gatewayUrlFor, type GatewayConfig } from './gateway-config.js';

let active: GatewayConfig = GATEWAY_CONFIG;

/**
 * This instance's gateway settings. They start as the startup snapshot (process env, then
 * config/.env, then the default) and change only when the server's gateway manager has to move
 * the gateway off an occupied port. A CLI process keeps the snapshot, which already reads a moved
 * port, because the manager saves it to config/.env.
 */
export function activeGatewayConfig(): GatewayConfig {
  return active;
}

/** Base URL of this instance's gateway, e.g. `http://127.0.0.1:9880`. */
export function gatewayUrl(): string {
  return active.url;
}

/** Record the port the gateway binds. A moved port is saved to config/.env, so from here on it
 *  counts as an explicit setting, which the gateway.yaml writers copy into `port:`. */
export function setActiveGatewayPort(port: number): void {
  if (port === active.port) return;
  active = port === GATEWAY_CONFIG.port
    ? GATEWAY_CONFIG
    : { ...GATEWAY_CONFIG, port, portOverride: port, url: gatewayUrlFor(port) };
}
