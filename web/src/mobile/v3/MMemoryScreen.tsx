// 1j 项目记忆 — the current project's memory tree, drilled from the project page (scheme 1e→1j). NON-Tab
// drill page (the shell hides the Tab bar for /m/memory). READ-ONLY. Real tRPC: `memory.tree({ projectId })`
// scoped to the mobile current project. Back → the project page (1e). Files tap through to the read-only
// file viewer (/m/memory/file); the four memory dirs are accordions whose open-state is owned here. Writes
// to behavioral content (rules/skills) still go through approval (agent-only).
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useMobileProject } from '@/mobile/current-project';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MMemoryView, type MMemoryCopy } from './MMemoryView';
import { buildMMemoryVm } from './m-memory-vm';

const COPY: { en: MMemoryCopy; zh: MMemoryCopy } = {
  en: {
    title: 'Project memory',
    core: 'Core',
    filesUnit: 'files',
    emptyDir: 'Empty',
    footer: 'Tap a file for a read-only preview · agent writes to behavioral content (rules/skills) go through approval',
    empty: 'No project memory yet',
  },
  zh: {
    title: '项目记忆',
    core: '核心',
    filesUnit: '个文件',
    emptyDir: '空',
    footer: '点文件只读预览 · agent 写入行为性内容（规则/技能）走审批',
    empty: '暂无项目记忆',
  },
};

export function MMemoryScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const now = Date.now();
  const { currentProjectId } = useMobileProject();

  const treeQuery = useQuery({
    ...trpc.memory.tree.queryOptions({ projectId: currentProjectId ?? '' }),
    enabled: !!currentProjectId,
  });
  const vm = useMemo(() => buildMMemoryVm(treeQuery.data, now), [treeQuery.data, now]);

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
    <MScreen label="1j 项目记忆">
      {treeQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      ) : (
        <MMemoryView
          vm={vm}
          copy={copy}
          openDirs={openDirs}
          onToggleDir={toggleDir}
          onBack={() => navigate('/m/project')}
          onOpenFile={(path) => navigate(`/m/memory/file?path=${encodeURIComponent(path)}`)}
        />
      )}
    </MScreen>
  );
}
