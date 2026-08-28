// input:  project registry, shared sessions, explicit selection, and shell project order
// output: shared current-project context, listed projects, and rendered project order
// pos:    Cross-surface project selection and ordering state owner
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProjectConduitInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { resolveCurrentProjectId } from './current-project';
import { useAllSessions } from './useProjectSessions';

export interface CurrentProjectContextValue {
  currentProjectId: string | null;
  projects: ProjectConduitInfo[];
  projectOrder: string[];
  setCurrentProject: (id: string) => void;
  setProjectOrder: (ids: string[]) => void;
}

const CurrentProjectContext = createContext<CurrentProjectContextValue | null>(null);

export function CurrentProjectProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const projectsQuery = useQuery({ ...trpc.projects.list.queryOptions({}), refetchOnMount: false });
  const sessionsQuery = useAllSessions('direct');
  useAllSessions('scheduled');
  const [override, setOverride] = useState<string | null>(null);
  const [projectOrder, setProjectOrderState] = useState<string[]>([]);

  const projects = projectsQuery.data ?? [];
  const currentProjectId = resolveCurrentProjectId(
    override,
    sessionsQuery.data ?? [],
    projects,
  );
  const setCurrentProject = useCallback((id: string) => setOverride(id), []);
  const setProjectOrder = useCallback((ids: string[]) => {
    setProjectOrderState((previous) => (
      previous.length === ids.length && previous.every((id, index) => id === ids[index])
        ? previous
        : [...ids]
    ));
  }, []);
  const value = useMemo(
    () => ({ currentProjectId, projects, projectOrder, setCurrentProject, setProjectOrder }),
    [currentProjectId, projects, projectOrder, setCurrentProject, setProjectOrder],
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
