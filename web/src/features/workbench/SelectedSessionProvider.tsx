import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useCurrentProject } from './CurrentProjectProvider';
import { resolveSelectedSessionId, DRAFT_SENTINEL } from './selected-session';

// Cross-pane "selected session" state. A single source of truth for which session the center chat
// shows, written by the LeftRail session rows (+ the "+ New session" control) and read by CenterChat.
// The provider owns the derivation: it queries the current project's direct sessions (react-query
// dedupes with LeftRail's identical query — no extra network) and holds an explicit user override.
// Effective selection = override (while still in the list) else the most-recent session. Because the
// session list is scoped to the current project, switching project re-points the chat automatically.
// Scoped to WorkbenchPage, inside CurrentProjectProvider (it reads the current project).

interface SelectedSessionContextValue {
  selectedSessionId: string | null;
  setSelectedSession: (id: string) => void;
  /** Select a session that was JUST created (createAndSend). Same as setSelectedSession but marks
   *  the id as "pending" so it stays selected across the gap before the refetched sessions.list
   *  contains its row — avoiding a flip to the previous most-recent session. */
  selectCreatedSession: (id: string) => void;
  /** True when the user is in a "New Conversation" draft (no session created yet). */
  isDraft: boolean;
  /** The user-chosen profile for the draft session (null = use system default). */
  draftProfile: string | null;
  setDraftProfile: (name: string) => void;
  /** Exit draft mode (e.g. after createAndSend succeeds, or user clicks a real session). */
  clearDraft: () => void;
}

const SelectedSessionContext = createContext<SelectedSessionContextValue | null>(null);

export function SelectedSessionProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const { currentProjectId } = useCurrentProject();
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );
  const configQuery = useQuery(trpc.config.get.queryOptions({}));
  const [override, setOverride] = useState<string | null>(null);
  const [draftProfile, setDraftProfile] = useState<string | null>(null);
  // A just-created session (createAndSend) whose row hasn't landed in the refetched list yet.
  const [pendingCreatedId, setPendingCreatedId] = useState<string | null>(null);

  const sessions = sessionsQuery.data ?? [];
  const selectedSessionId = resolveSelectedSessionId(override, sessions, pendingCreatedId);
  const isDraft = selectedSessionId === DRAFT_SENTINEL;

  // Once the freshly created session appears in the list, drop the pending marker — the plain
  // override now resolves it via the normal list-membership path.
  useEffect(() => {
    if (pendingCreatedId && sessions.some((s) => s.sessionId === pendingCreatedId)) {
      setPendingCreatedId(null);
    }
  }, [pendingCreatedId, sessions]);

  // A project switch invalidates any pending marker (the new session belongs to the previous
  // project's list); the override then falls back to the new project's most-recent session.
  useEffect(() => {
    setPendingCreatedId(null);
  }, [currentProjectId]);

  // When entering draft mode, pick up the system default profile if none chosen yet.
  useEffect(() => {
    if (isDraft && !draftProfile && configQuery.data?.profiles) {
      const def = configQuery.data.profiles.defaultProfile;
      if (def && configQuery.data.profiles.profiles.find(p => p.name === def)) {
        setDraftProfile(def);
      }
    }
  }, [isDraft, draftProfile, configQuery.data]);

  const setSelectedSession = useCallback((id: string) => {
    setPendingCreatedId(null);
    setOverride(id);
  }, []);
  const selectCreatedSession = useCallback((id: string) => {
    setPendingCreatedId(id);
    setOverride(id);
  }, []);
  const clearDraft = useCallback(() => {
    setPendingCreatedId(null);
    setOverride(null);
    setDraftProfile(null);
  }, []);

  const value = useMemo(
    () => ({ selectedSessionId, setSelectedSession, selectCreatedSession, isDraft, draftProfile, setDraftProfile, clearDraft }),
    [selectedSessionId, setSelectedSession, selectCreatedSession, isDraft, draftProfile, clearDraft],
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
