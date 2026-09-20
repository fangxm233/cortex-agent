import type {
  ConfigProfileEntry, ConfigSelectionDefault, SessionInfo, SessionSelectionOverride,
} from '@cortex-agent/ui-contract';

// Pure state logic for the cross-pane "selected session" (the session the center chat shows). A
// user click in the LeftRail sets an explicit override; absent one (or when the override no longer
// belongs to the current project's session list — e.g. after a project switch) the selection falls
// back to the most-recently-used session. This is what makes clicking a session row switch the chat,
// and makes switching project re-point the chat to that project's most-recent session.

/** Sentinel value for the "+ New session" draft placeholder. Not a real session — the session is
 *  created lazily on first message send (task 15b). */
export const DRAFT_SENTINEL = '__draft__';

/** What the session's own list row will eventually say, held across the gap in which it does not
 *  exist yet. Both halves travel together: a session created with an overridden model would
 *  otherwise flash its profile's model until `sessions.list` caught up. */
export interface PendingCreatedSession {
  sessionId: string;
  profileName: string | null;
  override: SessionSelectionOverride | null;
}

/** The composer's engine choice while there is no session to write it to. `profileName` null means
 *  "the configured default"; `override` null means "run that profile as declared". */
export interface DraftSelection {
  profileName: string | null;
  override: SessionSelectionOverride | null;
}

/** A change from the picker, in the same shape `sessions.setSelection` takes: an optional profile
 *  plus, optionally, the WHOLE selection to run on top of it. */
export interface SelectionChange {
  profileName?: string;
  selection?: SessionSelectionOverride;
}

export const EMPTY_DRAFT_SELECTION: DraftSelection = { profileName: null, override: null };

/** Apply a picker change to the draft — the client-side twin of `applyChannelSelection`, keeping the
 *  same rule: naming a profile alone means "run it as declared", so the old selection goes with it. */
export function applyDraftSelection(current: DraftSelection, change: SelectionChange): DraftSelection {
  const stated = change.selection;
  const kept = change.profileName ? null : current.override;
  const override = stated && Object.keys(stated).length > 0 ? { ...stated } : stated ? null : kept;
  return {
    profileName: change.profileName ?? current.profileName,
    override,
  };
}

/**
 * What a fresh draft starts on: the last engine chosen on this host (`config.selectionDefault`,
 * written by the server every time a selection is applied), falling back to the configured default
 * profile. Returns null when there is nothing worth seeding — the caller then leaves the draft as it
 * is rather than re-rendering it with the same values.
 *
 * The override rides along ONLY when its own profile is still there. A model / thinking level /
 * billing route is a choice made on top of one profile's backend and gateway route; re-hanging it on
 * a substitute profile is how a claude draft would end up asking for a PI model.
 */
export function seedDraftSelection(
  seed: ConfigSelectionDefault | null | undefined,
  profiles: ConfigProfileEntry[],
  defaultProfile: string | null,
): DraftSelection | null {
  const named = seed?.profileName && profiles.some((entry) => entry.name === seed.profileName)
    ? seed.profileName
    : null;
  const fallback = defaultProfile && profiles.some((entry) => entry.name === defaultProfile)
    ? defaultProfile
    : null;
  const profileName = named ?? fallback;
  const override: SessionSelectionOverride = {};
  if (named && seed) {
    if (seed.model) override.model = seed.model;
    if (seed.provider) override.provider = seed.provider;
    if (seed.thinking) override.thinking = seed.thinking;
    if (seed.mode) override.mode = seed.mode;
  }
  const hasOverride = Object.keys(override).length > 0;
  if (!profileName && !hasOverride) return null;
  return { profileName, override: hasOverride ? override : null };
}

// The ⌘N predicate that used to live here moved into the menu accelerator registry
// (shell/menu/menu-model `matchesAccel`), which now owns every app-wide shortcut.

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

/** Keep draft selection metadata only for its just-created session until the list snapshot arrives.
 *  The row wins the moment it exists — it is the server's answer, and the pending value was only
 *  ever a stand-in for it.
 *
 *  The two halves are resolved SEPARATELY. A session that names no profile is the normal case, not
 *  an absent row: it runs the configured default, and may still carry the model / thinking / route
 *  the user picked on top of it. Reading a null `profileName` as "nothing known yet" and dropping
 *  the override with it is what used to make such a session forget its own pick the moment
 *  `sessions.list` answered. */
export function resolveTransitionSelection(
  row: { profileName: string | null | undefined; override: SessionSelectionOverride | null | undefined },
  pendingCreated: PendingCreatedSession | null,
  sessionId: string | null | undefined,
): { profileName: string | null; override: SessionSelectionOverride | null } {
  const rowOverride = row.override ?? null;
  if (row.profileName != null) return { profileName: row.profileName, override: rowOverride };
  const pending = sessionId && pendingCreated?.sessionId === sessionId ? pendingCreated : null;
  return {
    profileName: pending?.profileName ?? null,
    override: rowOverride ?? pending?.override ?? null,
  };
}
