import * as path from 'path';
import { piGatewayMode } from '@core/gateway-routes.js';
import { readOAuthProviders } from '../../agent-adapter/pi/chatgpt-signin.js';
import { PI_AGENT_DIR } from '../../agent-adapter/pi/defaults.js';

/**
 * Gateway billing modes whose spend a subscription covers: the configured list plus the route of
 * every PI provider signed in with OAuth. PI routes each provider through its own gateway mode
 * (see gateway-routes.ts), and an OAuth credential there is a subscription login (Sign in with
 * ChatGPT on `openai`, for one), never a metered key. The same provider on an API key stays metered.
 */
export function subscriptionModesFor(
  configured: readonly string[],
  oauthProviders: ReadonlySet<string>,
): Set<string> {
  return new Set([...configured, ...[...oauthProviders].map(piGatewayMode)]);
}

/** Providers the daemon's PI sessions are signed in to with OAuth, read from their auth.json. */
export function readDaemonOAuthProviders(): Set<string> {
  return readOAuthProviders(path.join(PI_AGENT_DIR, 'auth.json'));
}
