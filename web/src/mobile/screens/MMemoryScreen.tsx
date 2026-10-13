import { mobileHeaderBack } from '@/mobile/mobile-navigation';
// 1j 项目记忆 — the current project's memory tree, drilled from the project panel (scheme 1e→1j). A
// drill page. READ-ONLY. Real tRPC: `memory.tree({ projectId })`
// scoped to the mobile current project. Back → the project page (1e). Files tap through to the read-only
// file viewer (/m/memory/file); memory dirs are accordions whose open-state is owned here. Writes to
// behavioral content (rules/skills) still go through approval (agent-only).
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang, useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { deriveMemoryTreeFacts } from '@/features/memory/memory-tree';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MMemoryView } from './MMemoryView';
import { buildMMemoryVm } from './m-memory-vm';

export function MMemoryScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const L = useVocab();
  const now = Date.now();
  const { currentProjectId } = useCurrentProject();

  const treeQuery = useQuery({
    ...trpc.memory.tree.queryOptions({ projectId: currentProjectId ?? '' }),
    enabled: !!currentProjectId,
  });
  const treeFacts = useMemo(() => deriveMemoryTreeFacts(treeQuery.data), [treeQuery.data]);
  const vm = useMemo(() => buildMMemoryVm(treeFacts, now, lang), [treeFacts, now, lang]);

  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const toggleDir = useCallback((name: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return (
    <MScreen label="1j memory">
      {treeQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{L.memEmpty}</div>
      ) : (
        <MMemoryView
          vm={vm}
          openDirs={openDirs}
          onToggleDir={toggleDir}
          onBack={() => mobileHeaderBack(navigate, '/m/project')}
          onOpenFile={(path) => navigate(`/m/memory/file?path=${encodeURIComponent(path)}`)}
        />
      )}
    </MScreen>
  );
}
