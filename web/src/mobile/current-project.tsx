import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { resolveCurrentProjectId } from '@/features/workbench/current-project';

// Mobile-wide "current project" state (scheme v3: 项目 is the global scope — 会话/线程/任务 only show the
// current project; the 项目 tab switches it). A single source of truth shared by every tab and the
// project switcher, mounted above the router in MobileShell so it survives tab/route changes. Reuses
// the desktop pure derivation (`resolveCurrentProjectId`): effective id = explicit override (set by the
// 项目 switcher) ?? derived default (most-recent session's project, else first listed project).

interface MobileProjectContextValue {
  currentProjectId: string | null;
  setCurrentProject: (id: string) => void;
}

const MobileProjectContext = createContext<MobileProjectContextValue | null>(null);

export function MobileProjectProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const projectsQuery = useQuery(trpc.projects.list.queryOptions({}));
  const sessionsQuery = useQuery(trpc.sessions.list.queryOptions({ origin: 'direct' }));
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

  return <MobileProjectContext.Provider value={value}>{children}</MobileProjectContext.Provider>;
}

export function useMobileProject(): MobileProjectContextValue {
  const ctx = useContext(MobileProjectContext);
  if (!ctx) throw new Error('useMobileProject must be used within a MobileProjectProvider');
  return ctx;
}
