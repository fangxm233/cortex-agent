// Mobile 项目记忆 file viewer — /m/memory/file?path=<rel>. Read-only. Drilled from the 1j memory tree
// (MMemoryScreen). NON-Tab drill page (the shell hides the Tab bar for /m/memory*). Real tRPC:
// `memory.file({ projectId, path })` scoped to the mobile current project; `path` comes from the
// query string (may contain slashes, e.g. `experiments/EXP-001.md`). Back → the memory tree (1j).
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useMobileProject } from '@/mobile/current-project';
import { MMemoryFileView, type MMemoryFileCopy, type MMemoryFileStatus } from './MMemoryFileView';
import { fileBasename, fileMetaLine } from './m-memory-file-vm';

const COPY: { en: MMemoryFileCopy; zh: MMemoryFileCopy } = {
  en: {
    loading: 'Loading file…',
    error: "Couldn't read this file",
    empty: '(empty file)',
  },
  zh: {
    loading: '正在加载文件…',
    error: '无法读取该文件',
    empty: '（空文件）',
  },
};

export function MMemoryFileScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const now = Date.now();
  const [params] = useSearchParams();
  const path = params.get('path') ?? '';
  const { currentProjectId } = useMobileProject();

  const fileQuery = useQuery({
    ...trpc.memory.file.queryOptions({ projectId: currentProjectId ?? '', path }),
    enabled: !!currentProjectId && !!path,
  });
  const file = fileQuery.data;

  const basename = fileBasename(path);
  const metaLine = useMemo(() => fileMetaLine(file, now), [file, now]);

  const status: MMemoryFileStatus = !path || fileQuery.isError
    ? 'error'
    : fileQuery.isLoading || !file
      ? 'loading'
      : file.content.length === 0
        ? 'empty'
        : 'ready';

  return (
    <MMemoryFileView
      basename={basename}
      metaLine={metaLine}
      content={file?.content ?? ''}
      status={status}
      copy={copy}
      onBack={() => navigate('/m/memory')}
    />
  );
}
