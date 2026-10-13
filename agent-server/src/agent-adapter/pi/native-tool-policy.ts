/** PI-native allowlist uses Claude labels; it is separate from the bundled MCP gate. */
export function allowedToolLabels(env: NodeJS.ProcessEnv): Set<string> | null {
  const value = env.CORTEX_PI_ALLOWED_TOOLS?.trim();
  if (!value) return null;
  return new Set(value.split(',').map(tool => tool.trim()).filter(Boolean));
}

export function hasNativeAgent(env: NodeJS.ProcessEnv): boolean {
  const allowed = allowedToolLabels(env);
  return env.CORTEX_PI_SUBAGENT !== '1' && (allowed === null || allowed.has('Agent'));
}
