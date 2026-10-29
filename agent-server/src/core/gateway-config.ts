import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { parse } from 'dotenv';

export const DEFAULT_GATEWAY_PORT = 9880;

export interface GatewayConfig {
  port: number;
  portOverride?: number;
  url: string;
  /** Only set when the gateway child needs a private OS home. */
  home?: string;
  aistatusDir: string;
  configPath: string;
}

/** The gateway always listens on loopback. */
export function gatewayUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CORTEX_GATEWAY_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function parseHome(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value)) throw new Error('CORTEX_GATEWAY_HOME must be an absolute path');
  return path.resolve(value);
}

export function resolveGatewayConfig(env: NodeJS.ProcessEnv, fileEnv: NodeJS.ProcessEnv, osHome: string): GatewayConfig {
  const portOverride = parsePort(env.CORTEX_GATEWAY_PORT ?? fileEnv.CORTEX_GATEWAY_PORT);
  const port = portOverride ?? DEFAULT_GATEWAY_PORT;
  const home = parseHome(env.CORTEX_GATEWAY_HOME ?? fileEnv.CORTEX_GATEWAY_HOME);
  const aistatusDir = path.join(home ?? osHome, '.aistatus');
  return { port, portOverride, home, aistatusDir, configPath: path.join(aistatusDir, 'gateway.yaml'), url: gatewayUrlFor(port) };
}

function readConfigEnv(configDir: string): NodeJS.ProcessEnv {
  try { return parse(readFileSync(path.join(configDir, '.env'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {};
}

/** CLI imports precede runtime dotenv loading, so read startup settings without populating env. */
export function loadGatewayConfig(configDir: string, env = process.env, osHome = homedir()): GatewayConfig {
  return resolveGatewayConfig(env, readConfigEnv(configDir), osHome);
}

/** The gateway port saved in config/.env, ignoring the process env. */
export function savedGatewayPort(configDir: string): number | undefined {
  return parsePort(readConfigEnv(configDir).CORTEX_GATEWAY_PORT);
}

/** An explicit Cortex port wins; without one, retain the legacy add-only YAML merge. */
export function gatewayYamlPort(config: GatewayConfig, existing?: unknown): unknown {
  return config.portOverride ?? existing ?? config.port;
}
