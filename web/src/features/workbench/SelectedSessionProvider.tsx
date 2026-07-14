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

  const selectedSessionId = resolveSelectedSessionId(override, sessionsQuery.data ?? []);
  const isDraft = selectedSessionId === DRAFT_SENTINEL;

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
    setOverride(id);
  }, []);
  const clearDraft = useCallback(() => {
    setOverride(null);
    setDraftProfile(null);
  }, []);

  const value = useMemo(
    () => ({ selectedSessionId, setSelectedSession, isDraft, draftProfile, setDraftProfile, clearDraft }),
    [selectedSessionId, setSelectedSession, isDraft, draftProfile, clearDraft],
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
