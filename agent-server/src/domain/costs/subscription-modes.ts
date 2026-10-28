import * as path from 'path';
import { readOAuthProviders } from '../../agent-adapter/pi/chatgpt-signin.js';
import { PI_AGENT_DIR } from '../../agent-adapter/pi/defaults.js';

/**
 * Gateway billing modes whose spend a subscription covers: the configured list plus every PI
 * provider signed in with OAuth. PI routes each provider through the gateway mode of the same
 * name, and an OAuth credential there is a subscription login (Sign in with ChatGPT on `openai`,
 * for one), never a metered key. The same provider on an API key stays metered.
 */
export function subscriptionModesFor(
  configured: readonly string[],
  oauthProviders: ReadonlySet<string>,
): Set<string> {
  return new Set([...configured, ...oauthProviders]);
}

/** Providers the daemon's PI sessions are signed in to with OAuth, read from their auth.json. */
export function readDaemonOAuthProviders(): Set<string> {
  return readOAuthProviders(path.join(PI_AGENT_DIR, 'auth.json'));
}
