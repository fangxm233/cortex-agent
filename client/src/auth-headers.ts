// input:  client config (cortex-client.json) + process.env
// output: resolveClientToken + buildClientHeaders for the WS upgrade
// pos:    side-effect-free auth-header resolution for the cortex-client WebSocket.
//         The agent-server WS gate (fail-closed) requires `x-cortex-token`; the token is
//         distributed via cortex-client.json (clientToken) or CORTEX_CLIENT_TOKEN env.

/**
 * Resolve the WS bearer token. Env (CORTEX_CLIENT_TOKEN) takes precedence so an operator can
 * override; otherwise the durable `clientToken` from cortex-client.json is used. The config
 * path is the robust distribution channel (no reliance on the client process's inherited env,
 * which is fragile under systemd / SSH spawn). Returns '' when neither is set.
 */
export function resolveClientToken(
  cfg: { clientToken?: string },
  env: { CORTEX_CLIENT_TOKEN?: string },
): string {
  return (env.CORTEX_CLIENT_TOKEN?.trim() || cfg.clientToken?.trim() || '');
}

/** WS upgrade headers carrying the bearer token, or undefined when no token is configured. */
export function buildClientHeaders(token: string): Record<string, string> | undefined {
  const t = token?.trim();
  return t ? { 'x-cortex-token': t } : undefined;
}
