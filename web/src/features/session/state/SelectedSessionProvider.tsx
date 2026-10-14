import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useAllSessions, useProjectSessions } from '@/features/projects/useProjectSessions';
import {
  resolveSelectedSessionId,
  DRAFT_SENTINEL,
  type DraftSelection,
  type PendingCreatedSession,
  type SelectionChange,
} from './selected-session';
import { prefillProjectDraft } from '@/features/session/composer/composer-draft';
import { useDraftSelection } from './useDraftSelection';

// Cross-pane "selected session" state. A single source of truth for which session the center chat
// shows, written by the LeftRail session rows (+ the "+ New session" control) and read by CenterChat.
// The provider owns the derivation: it queries the current project's direct sessions (react-query
// dedupes with LeftRail's identical query — no extra network) and holds an explicit user override.
// Effective selection = override (while still in the list) else the most-recent session, which is
// then latched as the override so later activity cannot move the chat. Because the session list is
// scoped to the current project, switching project re-points the chat automatically.
// Mounted by AppShell, inside CurrentProjectProvider (it reads the current project).

interface SelectedSessionContextValue {
  selectedSessionId: string | null;
  setSelectedSession: (id: string) => void;
  /** Select a just-created session while retaining its profile until sessions.list catches up. */
  selectCreatedSession: (id: string) => void;
  pendingCreatedSession: PendingCreatedSession | null;
  /** True when the user is in a "New Conversation" draft (no session created yet). */
  isDraft: boolean;
  /** The engine the draft session will be created with: a profile (null = system default) plus the
   *  model / provider / thinking chosen on top of it. */
  draftSelection: DraftSelection;
  /** Patch the draft's engine choice — same semantics as the server's `sessions.setSelection`. */
  setDraftSelection: (change: SelectionChange) => void;
  /** Changes whenever another surface replaces the current project's draft text. */
  draftReloadToken: number;
  /** Seed a user-editable new-session draft without sending it. */
  prefillDraft: (text: string) => void;
}

const SelectedSessionContext = createContext<SelectedSessionContextValue | null>(null);

export function SelectedSessionProvider({ children }: { children: ReactNode }) {
  const { currentProjectId } = useCurrentProject();
  const sessionsQuery = useProjectSessions(currentProjectId, 'direct');
  // Scheduled runs are selectable rail rows too (design 27a-B) — without them in the membership
  // list, clicking a run would bounce the selection back to the most recent direct session.
  const scheduledSessionsQuery = useProjectSessions(currentProjectId, 'scheduled');
  const allDirectQuery = useAllSessions('direct');
  const allScheduledQuery = useAllSessions('scheduled');
  const [override, setOverride] = useState<string | null>(null);
  const [draftReloadToken, setDraftReloadToken] = useState(0);
  // A just-created session whose authoritative sessions.list row has not landed yet.
  const [pendingCreatedSession, setPendingCreatedSession] = useState<PendingCreatedSession | null>(null);

  const sessions = sessionsQuery.data ?? [];
  const selectableSessions = useMemo(
    () => [...sessions, ...(scheduledSessionsQuery.data ?? [])],
    [sessions, scheduledSessionsQuery.data],
  );
  const pendingCreatedId = pendingCreatedSession?.sessionId ?? null;
  const selectedSessionId = resolveSelectedSessionId(override, selectableSessions, pendingCreatedId, sessions);
  const isDraft = selectedSessionId === DRAFT_SENTINEL;
  const [draftSelection, setDraftSelection] = useDraftSelection(isDraft);

  // The most-recent fallback is a starting point, not a live value: latch it once both lists are in.
  // A stale override is replaced only when it provably belongs to another project, never while the
  // list merely has not caught up with a session selected elsewhere.
  const listsLoaded = sessionsQuery.isSuccess && scheduledSessionsQuery.isSuccess;
  const overrideElsewhere = override !== null && override !== DRAFT_SENTINEL
    && [...(allDirectQuery.data ?? []), ...(allScheduledQuery.data ?? [])]
      .some((s) => s.sessionId === override && s.projectId !== currentProjectId);
  useEffect(() => {
    if (!listsLoaded || !selectedSessionId || selectedSessionId === override) return;
    if (override === null || overrideElsewhere) setOverride(selectedSessionId);
  }, [listsLoaded, selectedSessionId, override, overrideElsewhere]);

  // Once the freshly created session appears in the list, drop the pending marker — the plain
  // override now resolves it via the normal list-membership path.
  useEffect(() => {
    if (pendingCreatedId && sessions.some((s) => s.sessionId === pendingCreatedId)) {
      setPendingCreatedSession(null);
    }
  }, [pendingCreatedId, sessions]);

  // A project switch invalidates pending metadata from the previous project's new session.
  useEffect(() => {
    setPendingCreatedSession(null);
  }, [currentProjectId]);

  const setSelectedSession = useCallback((id: string) => {
    setPendingCreatedSession(null);
    setOverride(id);
  }, []);
  const selectCreatedSession = useCallback((id: string) => {
    setPendingCreatedSession({
      sessionId: id,
      profileName: draftSelection.profileName,
      override: draftSelection.override,
      agentName: draftSelection.agentName ?? null,
    });
    setOverride(id);
  }, [draftSelection]);
  const prefillDraft = useCallback((text: string) => {
    prefillProjectDraft(currentProjectId ?? 'general', text);
    setPendingCreatedSession(null);
    setOverride(DRAFT_SENTINEL);
    setDraftReloadToken((value) => value + 1);
  }, [currentProjectId]);

  const value = useMemo(
    () => ({
      selectedSessionId,
      setSelectedSession,
      selectCreatedSession,
      pendingCreatedSession,
      isDraft,
      draftSelection,
      setDraftSelection,
      draftReloadToken,
      prefillDraft,
    }),
    [selectedSessionId, setSelectedSession, selectCreatedSession, pendingCreatedSession, isDraft,
      draftSelection, setDraftSelection, draftReloadToken, prefillDraft],
  );

  return <SelectedSessionContext.Provider value={value}>{children}</SelectedSessionContext.Provider>;
}

export function useSelectedSession(): SelectedSessionContextValue {
  const ctx = useContext(SelectedSessionContext);
  if (!ctx) {
    throw new Error('useSelectedSession must be used within a SelectedSessionProvider');
  }
  return ctx;
}
