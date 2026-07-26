// input:  project-scoped sessions/config queries and selected-session rules
// output: SelectedSessionProvider and useSelectedSession context hook
// pos:    Cross-pane selected and draft session state owner
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useCurrentProject } from './CurrentProjectProvider';
import {
  resolveSelectedSessionId,
  DRAFT_SENTINEL,
  type PendingCreatedSession,
} from './selected-session';

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
  /** Select a just-created session while retaining its profile until sessions.list catches up. */
  selectCreatedSession: (id: string) => void;
  pendingCreatedSession: PendingCreatedSession | null;
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
  // A just-created session whose authoritative sessions.list row has not landed yet.
  const [pendingCreatedSession, setPendingCreatedSession] = useState<PendingCreatedSession | null>(null);

  const sessions = sessionsQuery.data ?? [];
  const pendingCreatedId = pendingCreatedSession?.sessionId ?? null;
  const selectedSessionId = resolveSelectedSessionId(override, sessions, pendingCreatedId);
  const isDraft = selectedSessionId === DRAFT_SENTINEL;

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
    setPendingCreatedSession(null);
    setOverride(id);
  }, []);
  const selectCreatedSession = useCallback((id: string) => {
    setPendingCreatedSession({ sessionId: id, profileName: draftProfile });
    setOverride(id);
  }, [draftProfile]);
  const clearDraft = useCallback(() => {
    setPendingCreatedSession(null);
    setOverride(null);
    setDraftProfile(null);
  }, []);

  const value = useMemo(
    () => ({ selectedSessionId, setSelectedSession, selectCreatedSession, pendingCreatedSession, isDraft, draftProfile, setDraftProfile, clearDraft }),
    [selectedSessionId, setSelectedSession, selectCreatedSession, pendingCreatedSession, isDraft, draftProfile, clearDraft],
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
