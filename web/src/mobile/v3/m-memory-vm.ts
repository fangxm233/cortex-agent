// Pure view-model for the 1j 项目记忆 screen (scheme-mobile.dc.html 1j L523-554). Maps the real
// `memory.tree({ projectId })` DTO into a `核心` group (top-level files) + one card per memory dir.
// READ-ONLY. Only real DTO fields (name / sizeBytes / modifiedAt / entryCount) are surfaced — the
// scheme's `+42 −7` line-diff badges, `草稿` status badge, and per-file descriptors are design MOCKS
// with NO field on MemoryTree/MemoryFileEntry/MemoryDirEntry → never fabricated (see MMemoryView).
import type { MemoryTree } from '@cortex-agent/ui-contract';
import { relTimeZh } from '@/mobile/ui/format';

export interface MMemoryFileRow {
  /** Real filename (e.g. CORTEX.md). */
  name: string;
  /** Relative Chinese time from real `modifiedAt`; '' when unknown. */
  time: string;
}

export interface MMemoryDirCard {
  /** Real dir name WITHOUT trailing slash (the view appends `/`). */
  name: string;
  /** Real `*.md` entry count (excludes index.md / CORTEX.md — see MemoryDirEntry). */
  entryCount: number;
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

export function buildMMemoryVm(tree: MemoryTree | null | undefined, now: number = Date.now()): MMemoryVm {
  const files = tree?.files ?? [];
  const dirs = tree?.dirs ?? [];
  const core: MMemoryFileRow[] = files.map((f) => ({ name: f.name, time: relTimeZh(f.modifiedAt, now) }));
  const dirCards: MMemoryDirCard[] = dirs.map((d) => ({ name: d.name, entryCount: d.entryCount }));
  const fileCount = files.length + dirs.reduce((sum, d) => sum + d.entryCount, 0);
  return { fileCount, core, dirs: dirCards, isEmpty: core.length === 0 && dirCards.length === 0 };
}
