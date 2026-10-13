/** Compact display-only form of a stable Cortex session ID. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
