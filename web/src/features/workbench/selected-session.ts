import type { SessionInfo } from '@cortex-agent/ui-contract';

// Pure state logic for the cross-pane "selected session" (the session the center chat shows). A
// user click in the LeftRail sets an explicit override; absent one (or when the override no longer
// belongs to the current project's session list — e.g. after a project switch) the selection falls
// back to the most-recently-used session. This is what makes clicking a session row switch the chat,
// and makes switching project re-point the chat to that project's most-recent session.

/** Sentinel value for the "+ New session" draft placeholder. Not a real session — the session is
 *  created lazily on first message send (task 15b). */
export const DRAFT_SENTINEL = '__draft__';

/** Most-recently-used session id (by lastUsedAt, then createdAt), else null. */
export function deriveMostRecentSessionId(sessions: SessionInfo[]): string | null {
  if (!sessions.length) return null;
  return [...sessions].sort(
    (a, b) => Date.parse(b.lastUsedAt || b.createdAt) - Date.parse(a.lastUsedAt || a.createdAt),
  )[0]?.sessionId ?? null;
}

/** Effective selected session: an explicit override wins ONLY while it is still in the list,
 *  otherwise the derived most-recent. The DRAFT_SENTINEL always passes through (it is never in
 *  the list — that's the point). */
export function resolveSelectedSessionId(override: string | null, sessions: SessionInfo[]): string | null {
  if (override === DRAFT_SENTINEL) return DRAFT_SENTINEL;
  if (override && sessions.some((s) => s.sessionId === override)) return override;
  return deriveMostRecentSessionId(sessions);
}
