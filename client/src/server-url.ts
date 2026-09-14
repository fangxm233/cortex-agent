// input:  client config (cortex-client.json) + process.env
// output: resolveServerUrl — the WebSocket URL the cortex-client dials
// pos:    side-effect-free server-URL resolution for the cortex-client WebSocket.
//         A full URL (env CORTEX_SERVER_URL or config serverUrl) lets the client reach
//         the agent-server through a Cloudflare Tunnel over wss/443; otherwise it falls
//         back to ws://<serverHost>:<serverPort> for direct/LAN reach.

/**
 * Resolve the WebSocket URL the cortex-client connects to.
 *
 * Precedence: ``CORTEX_SERVER_URL`` env > config ``serverUrl`` > ``ws://host:port``.
 * The env override lets an operator point a client at a tunnel without editing the
 * durable config; ``serverUrl`` is the durable tunnel route in cortex-client.json.
 */
export function resolveServerUrl(
  cfg: { serverUrl?: string; serverHost?: string; serverPort?: number },
  env: { CORTEX_SERVER_URL?: string },
): string {
  const envUrl = env.CORTEX_SERVER_URL?.trim();
  if (envUrl) return envUrl;
  const cfgUrl = cfg.serverUrl?.trim();
  if (cfgUrl) return cfgUrl;
  return `ws://${cfg.serverHost}:${cfg.serverPort || 3002}`;
}
