// input:  project registry and shared unscoped session queries
// output: selected desktop project context
// pos:    Derives and owns the workbench project selection
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { resolveCurrentProjectId } from './current-project';
import { useAllSessions } from './useProjectSessions';

// Cross-pane "current project" state (task 569c). A single source of truth for which project the
// workbench is scoped to, shared by the LeftRail project switcher (writer) and the panes that read it
// (RightPanel cost bar). The provider owns the derivation — it queries projects + direct sessions
// (react-query dedupes with LeftRail's identical queries, so no extra network) and holds an explicit
// user override set via the switcher. Effective currentProjectId = override ?? derived default; an
// explicit switch is sticky (wins over the most-recent-session default). Scoped to WorkbenchPage.

interface CurrentProjectContextValue {
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
  const ctx = useContext(CurrentProjectContext);
  if (!ctx) {
    throw new Error('useCurrentProject must be used within a CurrentProjectProvider');
  }
  return ctx;
}
