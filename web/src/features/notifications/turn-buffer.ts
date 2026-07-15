// Pure per-session "latest assistant message" buffer for turn-scoped DM notifications. Within one
// turn the agent may emit several assistant messages; rather than a toast per message we surface ONE
// toast at turn end (the `session.status` running:false boundary) previewing the final one. This
// module is framework-agnostic and deterministic — the React glue (NotificationProvider) owns the
// Map + the SSE wiring and delegates the newest-wins / flush logic here so it can be unit-tested.

export interface BufferedTurnMessage {
  text: string;
  ts: string;
}

/** Record the latest assistant message for a session (newest wins within a turn). */
export function recordTurnMessage(
  buffer: Map<string, BufferedTurnMessage>,
  sessionId: string,
  msg: BufferedTurnMessage,
): void {
  buffer.set(sessionId, msg);
}

/** Take and clear the buffered message for a session at turn end; null when nothing was buffered. */
export function takeTurnMessage(
  buffer: Map<string, BufferedTurnMessage>,
  sessionId: string,
): BufferedTurnMessage | null {
  const msg = buffer.get(sessionId) ?? null;
  buffer.delete(sessionId);
  return msg;
}
