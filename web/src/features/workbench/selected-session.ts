// input:  SessionInfo, pending session metadata and key events
// output: draft sentinel, selection and shortcut resolvers
// pos:    Workbench selected-session state rules
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import type { SessionInfo } from '@cortex-agent/ui-contract';

// Pure state logic for the cross-pane "selected session" (the session the center chat shows). A
// user click in the LeftRail sets an explicit override; absent one (or when the override no longer
// belongs to the current project's session list — e.g. after a project switch) the selection falls
// back to the most-recently-used session. This is what makes clicking a session row switch the chat,
// and makes switching project re-point the chat to that project's most-recent session.

/** Sentinel value for the "+ New session" draft placeholder. Not a real session — the session is
 *  created lazily on first message send (task 15b). */
export const DRAFT_SENTINEL = '__draft__';

export interface PendingCreatedSession {
  sessionId: string;
  profileName: string | null;
}

interface ShortcutLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isNewSessionShortcut(event: ShortcutLike): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n';
}

/** Most-recently-used session id (by lastUsedAt, then createdAt), else null. */
export function deriveMostRecentSessionId(sessions: SessionInfo[]): string | null {
  if (!sessions.length) return null;
  return [...sessions].sort(
    (a, b) => Date.parse(b.lastUsedAt || b.createdAt) - Date.parse(a.lastUsedAt || a.createdAt),
  )[0]?.sessionId ?? null;
}

/** Effective selected session: an explicit override wins ONLY while it is still in the list,
 *  otherwise the derived most-recent. The DRAFT_SENTINEL always passes through (it is never in
 *  the list — that's the point).
 *
 *  `pendingCreatedId` is a just-created session whose row has not yet landed in the (still
 *  refetching) `sessions.list`. Without it, the freshly created id — set as the override on
 *  createAndSend success — would fail the list-membership check and briefly fall back to the
 *  PREVIOUS most-recent session, flipping the chat to the old session and then back to the new one
 *  once the refetch lands. Passing it through keeps the chat on the new session across that gap.
 *
 *  `defaultPool` (design 27a-B): the membership list may include scheduled runs — they are valid
 *  CLICK targets — but the no/stale-override fallback derives from this pool (direct sessions
 *  only), so the workbench never auto-opens a run the user did not pick. Defaults to `sessions`. */
export function resolveSelectedSessionId(
  override: string | null,
  sessions: SessionInfo[],
  pendingCreatedId: string | null = null,
  defaultPool: SessionInfo[] = sessions,
): string | null {
  if (override === DRAFT_SENTINEL) return DRAFT_SENTINEL;
  if (pendingCreatedId && override === pendingCreatedId) return pendingCreatedId;
  if (override && sessions.some((s) => s.sessionId === override)) return override;
  return deriveMostRecentSessionId(defaultPool);
}

/** Keep draft profile metadata only for its just-created session until the list snapshot arrives. */
export function resolveTransitionProfile(
  currentProfile: string | null | undefined,
  pendingCreated: PendingCreatedSession | null,
  sessionId: string | null | undefined,
): string | null {
  if (currentProfile != null) return currentProfile;
  if (!sessionId || pendingCreated?.sessionId !== sessionId) return null;
  return pendingCreated.profileName;
}
