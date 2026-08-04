// input:  a gateway.yaml path and one endpoint/mode route
// output: single-route reads, upserts and removals preserving every other route
// pos:    Route-level editing of the aistatus gateway config
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

import { createLogger } from '@core/log.js';
import {
  readGatewayYaml, serializeGatewayYaml, type EndpointMap,
} from '@core/gateway-generator.js';

const log = createLogger('pi-custom-providers');

/** The config file the running gateway watches; edits are hot-reloaded within ~1s. */
export const GATEWAY_CONFIG_PATH = path.join(os.homedir(), '.aistatus', 'gateway.yaml');

export interface GatewayRouteSpec {
  /** Endpoint section (URL segment after the mode): `/m/<mode>/<endpoint>`. */
  endpoint: string;
  /** Mode name (billing/route selector). */
  mode: string;
  base_url: string;
  auth_style: string;
  /** Managed upstream keys. Empty means the gateway forwards the caller's own key. */
  keys: string[];
  passthrough: boolean;
}

interface GatewayDocument {
  top: Record<string, unknown>;
  endpoints: EndpointMap;
}

function readDocument(gatewayPath: string): GatewayDocument {
  const parsed = readGatewayYaml(gatewayPath);
  if (!parsed) return { top: {}, endpoints: {} };
  return { top: { ...parsed.top }, endpoints: parsed.endpoints };
}

function writeDocument(gatewayPath: string, doc: GatewayDocument): void {
  mkdirSync(path.dirname(gatewayPath), { recursive: true });
  if (existsSync(gatewayPath)) {
    try {
      copyFileSync(gatewayPath, `${gatewayPath}.bak`);
    } catch (err) {
      log.warn(`Failed to back up ${gatewayPath}: ${(err as Error).message}`);
    }
  }
  const content = serializeGatewayYaml({
    endpoints: doc.endpoints,
    top: doc.top,
    preservedCustom: [],
    droppedFromDiscovery: [],
  });
  writeFileSync(gatewayPath, content, 'utf8');
}

/** The stored route config, or null when that endpoint/mode pair is absent. */
export function readGatewayRoute(
  gatewayPath: string,
  endpoint: string,
  mode: string,
): Record<string, unknown> | null {
  const { endpoints } = readDocument(gatewayPath);
  return endpoints[endpoint]?.[mode] ?? null;
}

/**
 * Write one route, replacing it if it already exists. This is the update path the discovery merge
 * deliberately lacks — `mergeGatewayConfig` is add-only so it can never clobber hand-maintained
 * routes, which also means it can never edit one.
 */
export function upsertGatewayRoute(gatewayPath: string, route: GatewayRouteSpec): void {
  const doc = readDocument(gatewayPath);
  const config: Record<string, unknown> = {
    base_url: route.base_url,
    auth_style: route.auth_style,
    passthrough: route.passthrough,
  };
  if (route.keys.length > 0) config.keys = [...route.keys];

  doc.endpoints[route.endpoint] = { ...doc.endpoints[route.endpoint], [route.mode]: config };
  doc.top.port ??= 9880;
  doc.top.status_check ??= true;
  // Never steal the active billing mode from an existing config; only seed it on a fresh file.
  if (typeof doc.top.mode !== 'string' || doc.top.mode === '') doc.top.mode = route.mode;

  writeDocument(gatewayPath, doc);
}

/** Remove one route, dropping the endpoint section once its last mode is gone. */
export function removeGatewayRoute(gatewayPath: string, endpoint: string, mode: string): boolean {
  const doc = readDocument(gatewayPath);
  const modes = doc.endpoints[endpoint];
  if (!modes || !(mode in modes)) return false;
  const remaining = { ...modes };
  delete remaining[mode];
  if (Object.keys(remaining).length === 0) delete doc.endpoints[endpoint];
  else doc.endpoints[endpoint] = remaining;
  writeDocument(gatewayPath, doc);
  return true;
}
