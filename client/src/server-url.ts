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
