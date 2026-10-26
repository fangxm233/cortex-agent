import type { ConfigSelectionDefault, EngineSelection, SessionInfo } from '@cortex-agent/ui-contract';

export const DRAFT_SENTINEL = '__draft__';
export interface DraftSelection {
  selection: EngineSelection | null;
  agentName?: string | null;
  /** The session this draft creates works in its own folder without project context. Every new
   *  draft starts with it off. */
  clean?: boolean;
}
export interface PendingCreatedSession extends DraftSelection {
  sessionId: string;
  agentName: string | null;
}
export interface SelectionChange {
  selection?: EngineSelection;
  agentName?: string | null;
  /** Draft only: a running session's clean mode is fixed at creation. */
  clean?: boolean;
}
export const EMPTY_DRAFT_SELECTION: DraftSelection = { selection: null };

export function applyDraftSelection(current: DraftSelection, change: SelectionChange): DraftSelection {
  return { ...current, ...change };
}

/** Leaving a draft drops its clean choice, so the next draft starts with it off. */
export function clearDraftClean(current: DraftSelection): DraftSelection {
  if (current.clean === undefined) return current;
  const { clean: _clean, ...rest } = current;
  return rest;
}

export function seedDraftSelection(
  seed: ConfigSelectionDefault | null | undefined,
  fallback: EngineSelection | null,
): DraftSelection | null {
  const picked = seed ?? fallback;
  if (!picked) return null;
  const { backend, provider, model, thinking, mode } = picked;
  return { selection: { backend, provider, model, thinking, mode }, ...(seed?.agentName ? { agentName: seed.agentName } : {}) };
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

export function resolveTransitionAgent(
  rowAgent: string | null | undefined,
  pendingCreated: PendingCreatedSession | null,
  sessionId: string | null | undefined,
): string | null {
  if (rowAgent !== undefined) return rowAgent;
  const pending = sessionId && pendingCreated?.sessionId === sessionId ? pendingCreated : null;
  return pending?.agentName ?? null;
}

/** Whether the open session runs in clean mode: its row once it is listed, the draft it was
 *  created from until then. */
export function resolveTransitionClean(
  rowClean: boolean | undefined,
  pendingCreated: PendingCreatedSession | null,
  sessionId: string | null | undefined,
): boolean {
  if (rowClean !== undefined) return rowClean;
  return !!sessionId && pendingCreated?.sessionId === sessionId && pendingCreated.clean === true;
}

export function resolveTransitionSelection(
  row: EngineSelection | null | undefined,
  pendingCreated: PendingCreatedSession | null,
  sessionId: string | null | undefined,
): EngineSelection | null {
  if (row !== undefined) return row;
  return pendingCreated?.sessionId === sessionId ? pendingCreated?.selection ?? null : null;
}
