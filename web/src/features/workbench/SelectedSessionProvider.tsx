import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useCurrentProject } from './CurrentProjectProvider';
import { resolveSelectedSessionId } from './selected-session';

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
}

const SelectedSessionContext = createContext<SelectedSessionContextValue | null>(null);

export function SelectedSessionProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const { currentProjectId } = useCurrentProject();
  const sessionsQuery = useQuery(
    trpc.sessions.list.queryOptions({ origin: 'direct', projectId: currentProjectId ?? undefined }),
  );
  const [override, setOverride] = useState<string | null>(null);

  const selectedSessionId = resolveSelectedSessionId(override, sessionsQuery.data ?? []);
  const setSelectedSession = useCallback((id: string) => setOverride(id), []);
  const value = useMemo(
    () => ({ selectedSessionId, setSelectedSession }),
    [selectedSessionId, setSelectedSession],
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
