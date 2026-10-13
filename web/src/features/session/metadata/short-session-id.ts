// Compact display identity; the full UUID remains the stable session identifier.
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}
