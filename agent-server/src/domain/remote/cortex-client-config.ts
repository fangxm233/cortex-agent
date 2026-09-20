export interface ClientConnectEnv {
  CORTEX_SERVER_URL?: string;
  CORTEX_SERVER_HOST?: string;
  CORTEX_SERVER_PORT?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  CORTEX_CLIENT_TOKEN?: string;
  // Index signature so Node's process.env (NodeJS.ProcessEnv) is assignable.
  [key: string]: string | undefined;
}

/**
 * Resolve the WebSocket URL the cortex-client dials.
 *
 * A full ``CORTEX_SERVER_URL`` (e.g. ``wss://cortex.example.com``) takes
 * precedence so the client can reach the agent-server through a Cloudflare
 * Tunnel over 443/TLS. Otherwise it falls back to ``ws://<host>:<port>`` for
 * direct/LAN reach.
 */
export function resolveServerUrl(env: ClientConnectEnv): string {
  const url = env.CORTEX_SERVER_URL?.trim();
  if (url) return url;
  const port = env.CORTEX_SERVER_PORT || '3002';
  return `ws://${env.CORTEX_SERVER_HOST}:${port}`;
}

/**
 * Cloudflare Access service-token headers, returned only when both the client
 * id and secret are configured. These let the cortex-client pass a Cloudflare
 * Access policy placed in front of the tunnel (the agent-server WebSocket has
 * no auth of its own, so Access is the gate when it is exposed publicly).
 */
export function buildAccessHeaders(
  env: ClientConnectEnv,
): Record<string, string> | undefined {
  const id = env.CF_ACCESS_CLIENT_ID?.trim();
  const secret = env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (id && secret) {
    return {
      'CF-Access-Client-Id': id,
      'CF-Access-Client-Secret': secret,
    };
  }
  return undefined;
}

/**
 * Connection headers the cortex-client sends on the WebSocket upgrade. Combines the
 * optional Cloudflare Access service-token headers with the Cortex bearer token
 * (``x-cortex-token`` from ``CORTEX_CLIENT_TOKEN``) that the agent-server's WebSocket
 * gate requires. Returns undefined when neither is configured.
 */
export function buildAuthHeaders(
  env: ClientConnectEnv,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(buildAccessHeaders(env) ?? {}) };
  const token = env.CORTEX_CLIENT_TOKEN?.trim();
  if (token) headers['x-cortex-token'] = token;
  return Object.keys(headers).length > 0 ? headers : undefined;
}
