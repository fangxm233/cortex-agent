// input:  Shared memory-tree facts and an optional clock
// output: Mobile core rows, directory accordions, relative times, and total count
// pos:    Pure mobile project-memory presentation model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { MemoryTreeFacts } from '@/features/memory/memory-tree';
import { relTimeZh } from '@/mobile/ui/format';

export interface MMemoryFileRow {
  /** Real filename (e.g. CORTEX.md). */
  name: string;
  /** Real project-root-relative path used to open the file (`memory.file` path arg). */
  path: string;
  /** Relative Chinese time from real `modifiedAt`; '' when unknown. */
  time: string;
}

export interface MMemoryDirCard {
  /** Real dir name WITHOUT trailing slash (the view appends `/`). */
  name: string;
  /** Real `*.md` entry count (excludes index.md / CORTEX.md — see MemoryDirEntry). */
  entryCount: number;
  /** The dir's real file entries (accordion body), each openable via its `path`. */
  entries: MMemoryFileRow[];
}

export interface MMemoryVm {
  /** Honest total memory file count = top-level files + Σ dir entryCount (header `memory/ · N 个文件`). */
  fileCount: number;
  /** `核心` card rows — the real top-level files, input order. */
  core: MMemoryFileRow[];
  /** One card per memory dir, input order. */
  dirs: MMemoryDirCard[];
  isEmpty: boolean;
}

export function buildMMemoryVm(
  facts: MemoryTreeFacts | null | undefined,
  now: number = Date.now(),
): MMemoryVm {
  const core: MMemoryFileRow[] = (facts?.topLevelFiles ?? []).map((file) => ({
    name: file.name,
    path: file.path,
    time: relTimeZh(file.modifiedAt, now),
  }));
  const dirCards: MMemoryDirCard[] = (facts?.dirs ?? []).map((dir) => ({
    name: dir.name,
    entryCount: dir.entryCount,
    entries: dir.entries.map((file) => ({
      name: file.name,
      path: file.path,
      time: relTimeZh(file.modifiedAt, now),
    })),
  }));
  return {
    fileCount: facts?.fileCount ?? 0,
    core,
    dirs: dirCards,
    isEmpty: core.length === 0 && dirCards.length === 0,
  };
}
