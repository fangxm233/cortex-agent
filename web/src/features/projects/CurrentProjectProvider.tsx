// input:  project registry, shared unscoped session queries, and explicit selections
// output: shared current-project context for desktop and mobile consumers
// pos:    Cross-surface project selection state owner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { resolveCurrentProjectId } from './current-project';
import { useAllSessions } from './useProjectSessions';

export interface CurrentProjectContextValue {
  currentProjectId: string | null;
  setCurrentProject: (id: string) => void;
}

const CurrentProjectContext = createContext<CurrentProjectContextValue | null>(null);

export function CurrentProjectProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const projectsQuery = useQuery({ ...trpc.projects.list.queryOptions({}), refetchOnMount: false });
  const sessionsQuery = useAllSessions('direct');
  useAllSessions('scheduled');
  const [override, setOverride] = useState<string | null>(null);

  const currentProjectId = resolveCurrentProjectId(
    override,
    sessionsQuery.data ?? [],
    projectsQuery.data ?? [],
  );
  const setCurrentProject = useCallback((id: string) => setOverride(id), []);
  const value = useMemo(
    () => ({ currentProjectId, setCurrentProject }),
    [currentProjectId, setCurrentProject],
  );

  return (
    <CurrentProjectContext.Provider value={value}>{children}</CurrentProjectContext.Provider>
  );
}

export function useCurrentProject(): CurrentProjectContextValue {
  const context = useContext(CurrentProjectContext);
  if (!context) {
    throw new Error('useCurrentProject must be used within a CurrentProjectProvider');
  }
  return context;
}
