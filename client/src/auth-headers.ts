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
