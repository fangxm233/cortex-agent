import { createLogger } from '@core/log.js';
import { GATEWAY_MANAGED_KEY_PLACEHOLDER } from '@core/utils.js';
import { getSavedApiEnv } from '../auth/anthropic-env.js';
import { GATEWAY_URL, isGatewayHealthy } from '../costs/gateway-manager.js';

const log = createLogger('mode-env');

// Per-request mode URL: encodes mode in URL path so gateway resolves endpoints per-request
// instead of relying on global POST /mode state (eliminates race conditions)
function gatewayModeUrl(mode: string, metadata?: Record<string, string>): string {
  if (metadata && Object.keys(metadata).length > 0) {
    const metaStr = Object.entries(metadata)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join(",");
    return `${GATEWAY_URL}/m/${mode}/${metaStr}/anthropic`;
  }
  return `${GATEWAY_URL}/m/${mode}/anthropic`;
}

/**
 * Which Anthropic route one connection needs. The base URL is always fully decided by the
 * route, so `undefined` there means "this route has no base URL" (unset the variable).
 * For the credentials, absent = the route has no opinion (leave as-is), null = must be deleted.
 */
export interface ModeEnv {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string | null;
  CLAUDE_CODE_OAUTH_TOKEN?: string | null;
}

function gatewayModeEnv(mode: string, metadata?: Record<string, string>): ModeEnv {
  const ANTHROPIC_BASE_URL = gatewayModeUrl(mode, metadata);
  // An API key takes precedence over the subscription token on the passthrough route.
  if (mode === 'plan') return { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY: null };
  const saved = getSavedApiEnv();
  return {
    ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: saved.ANTHROPIC_API_KEY || GATEWAY_MANAGED_KEY_PLACEHOLDER,
  };
}

function directModeEnv(mode: string): ModeEnv {
  if (mode === 'plan') return { ANTHROPIC_API_KEY: null };
  const saved = getSavedApiEnv();
  return {
    ANTHROPIC_BASE_URL: saved.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: saved.ANTHROPIC_API_KEY || null,
    CLAUDE_CODE_OAUTH_TOKEN: saved.CLAUDE_CODE_OAUTH_TOKEN || null,
  };
}

/**
 * The mode decision as a value: reads the saved credentials, writes no env. It is applied to one
 * spawn's environment only (the run's per-attempt route → engine-spec's routeEnvFields); nothing
 * projects it onto the daemon's own env, which carries saved credentials alone (applyAuthEnv).
 */
export function resolveModeEnv(mode: string, metadata?: Record<string, string>): ModeEnv {
  if (isGatewayHealthy()) return gatewayModeEnv(mode, metadata);
  log.debug(`Gateway unhealthy — using direct Anthropic connection (mode=${mode})`);
  return directModeEnv(mode);
}
