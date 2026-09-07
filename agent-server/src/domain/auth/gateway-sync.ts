// input:  backend endpoint discovery, gateway and profile generators
// output: syncGatewayFromBackends — refresh model routing after a login
// pos:    Turns a successful backend login into usable gateway modes and profiles
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@core/log.js';
import { discoverEndpoints, writeMergedGatewayYaml, type DiscoveredEndpoint } from '@core/gateway-generator.js';
import { writeProfilesJson } from '@core/profile-generator.js';
import { CONFIG_DIR } from '@core/paths.js';

const log = createLogger('gateway-sync');

export interface GatewaySyncResult {
  /** True when gateway.yaml and profiles.json were regenerated. */
  configured: boolean;
  /** How many endpoints discovery reported. */
  endpoints: number;
  /** Profile names present after the sync (empty when nothing was written). */
  profiles: string[];
  /** Why nothing was written — 'no-endpoints' or an error message. */
  reason?: string;
}

export interface GatewaySyncOptions {
  /** Limit discovery to these backends. Omitted → discover everything available. */
  backends?: string[];
  /** Where profiles.json lives. Defaults to the running install's config dir. */
  configDir?: string;
  /** Where gateway.yaml lives. Defaults to ~/.aistatus. */
  gatewayConfigDir?: string;
  /** Injectable discovery seam (tests supply fixed endpoints instead of scanning the machine). */
  discover?: (backends?: string[]) => DiscoveredEndpoint[] | Promise<DiscoveredEndpoint[]>;
}

/**
 * Regenerate gateway.yaml and profiles.json from the backends that are reachable right now.
 *
 * Logging in is only half of becoming usable: the models a provider exposes are discovered by
 * scanning local backend state (PI's auth and model catalog, Claude config), and that scan previously ran
 * only inside `cortex init` and `cortex setup-gateway`. A user who logged in from the workbench
 * therefore had working credentials but no profile pointing at the newly reachable models, with no
 * in-product way to fix it. Running this after a successful login closes that loop.
 *
 * Both writes are merge-aware on purpose: `writeMergedGatewayYaml` keeps hand-maintained modes, and
 * profiles are written with `overwrite: false` so an operator's edited `plan` / `execute` survives —
 * a login must never silently re-point which model the agents run on. Only missing profiles are
 * filled in.
 *
 * Never throws. It runs on the tail of a login flow and inside a UI mutation; a discovery hiccup
 * must not fail the login that just succeeded, so problems come back as `configured: false`.
 */
export async function syncGatewayFromBackends(
  options: GatewaySyncOptions = {},
): Promise<GatewaySyncResult> {
  const discover = options.discover ?? discoverEndpoints;
  const configDir = options.configDir ?? CONFIG_DIR;
  try {
    const endpoints = await discover(options.backends);
    if (endpoints.length === 0) {
      log.info('No backend endpoints discovered — leaving gateway and profiles untouched');
      return { configured: false, endpoints: 0, profiles: [], reason: 'no-endpoints' };
    }

    writeMergedGatewayYaml(endpoints, options.gatewayConfigDir);
    writeProfilesJson(endpoints, { outputDir: configDir, overwrite: false });

    const profiles = readProfileNames(configDir);
    log.info(`Synced ${endpoints.length} endpoint(s) → profiles: ${profiles.join(', ')}`);
    return { configured: true, endpoints: endpoints.length, profiles };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`Gateway sync skipped: ${reason}`);
    return { configured: false, endpoints: 0, profiles: [], reason };
  }
}

/** Read back the profile names actually on disk, so the caller reports facts rather than intent. */
function readProfileNames(configDir: string): string[] {
  const file = path.join(configDir, 'profiles.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { profiles?: Record<string, unknown> };
    return Object.keys(parsed.profiles ?? {});
  } catch {
    return [];
  }
}
