import type { MemoryLineDiff, MemoryBlameLine } from '@cortex-agent/ui-contract';
import type { MemoryTreeFacts } from './memory-tree';
import type { MemoryDoc, MemoryDocStatus, MemoryKind, MemoryStatusKey } from './memory-doc';
import { timeAgo, type TimeLang } from '@/i18n/time-format';
import { fmt, type Vocab } from '@/i18n';

// Pure view-model helpers for the memory viewer's center view. No JSX, no fabricated data. Project
// selection is owned separately by features/projects; the document model lives in memory-doc.

/** The header's segmented control: the rendered document, or its per-line git history. */
export type MemoryMode = 'read' | 'changes';

/** The viewer opens on the document. History is one click away (header switch, or the change note's
 *  link) rather than the first thing a reader has to look past. */
export const DEFAULT_MEMORY_MODE: MemoryMode = 'read';

/** A file whose mtime falls inside this window carries the tree's "changed recently" dot. */
export const RECENT_CHANGE_MS = 24 * 60 * 60 * 1000;

/** True when `modifiedAt` parses and is less than `RECENT_CHANGE_MS` before `now`. */
export function isRecentChange(modifiedAt: string | null | undefined, now: number): boolean {
  const t = modifiedAt ? Date.parse(modifiedAt) : Number.NaN;
  return Number.isFinite(t) && now - t < RECENT_CHANGE_MS;
}

export interface TreeRow {
  /** Display name. A directory is told apart by its chevron, not a trailing slash. */
  name: string;
  kind: 'file' | 'dir';
  /** memory.file path for a selectable top-level or nested file; null for a directory row. */
  path: string | null;
  /** 0 for top-level files/directories, 1 for entries nested under a directory. */
  depth: 0 | 1;
  selectable: boolean;
  selected: boolean;
  /** Right-aligned plain count — the real dir `entryCount`; null for files (no line-count backend). */
  right: string | null;
  /** File changed within `RECENT_CHANGE_MS` (its real mtime); always false for a directory. */
  recent: boolean;
  /** Directory rows: whether its entries are listed below it. Null for files. */
  expanded: boolean | null;
}

export interface TreeRowOptions {
  /** Clock for the recent-change dot; without it no row is marked recent. */
  now?: number;
  /** Directory names whose entries are folded away. */
  collapsed?: ReadonlySet<string>;
}

/**
 * Tree rows for the file column: selectable top-level files followed by each directory and its real
 * selectable entries. Directory rows retain the server count and fold their entries; nested rows use
 * canonical memory.file paths from the shared facts. Files carry no fabricated line-count chip.
 */
export function buildTreeRows(facts: MemoryTreeFacts, selectedPath: string | null, options: TreeRowOptions = {}): TreeRow[] {
  const { now, collapsed } = options;
  const recent = (modifiedAt: string): boolean => now != null && isRecentChange(modifiedAt, now);
  const topLevelRows: TreeRow[] = facts.topLevelFiles.map((file) => ({
    name: file.name,
    kind: 'file',
    path: file.path,
    depth: 0,
    selectable: true,
    selected: file.path === selectedPath,
    right: null,
    recent: recent(file.modifiedAt),
    expanded: null,
  }));
  const dirRows = facts.dirs.flatMap<TreeRow>((dir) => {
    const expanded = !collapsed?.has(dir.name);
    return [
      {
        name: dir.name,
        kind: 'dir',
        path: null,
        depth: 0,
        selectable: false,
        selected: false,
        right: String(dir.entryCount),
        recent: false,
        expanded,
      },
      ...(expanded ? dir.entries : []).map<TreeRow>((file) => ({
        name: file.name,
        kind: 'file',
        path: file.path,
        depth: 1,
        selectable: true,
        selected: file.path === selectedPath,
        right: null,
        recent: recent(file.modifiedAt),
        expanded: null,
      })),
    ];
  });
  return [...topLevelRows, ...dirRows];
}

/** Whether any file in the tree (folded or not) carries the recent-change dot — the legend's cue. */
export function hasRecentChange(facts: MemoryTreeFacts, now: number): boolean {
  return [...facts.topLevelFiles, ...facts.dirs.flatMap((dir) => dir.entries)]
    .some((file) => isRecentChange(file.modifiedAt, now));
}

/** `Updated 2m ago` · `2分钟前更新` from an ISO timestamp; `Updated —` · `更新时间 —` when missing/unparseable. */
export function relTimeAgo(iso: string | null | undefined, now: number, lang: TimeLang, L: Vocab): string {
  const ago = timeAgo(iso, now, lang);
  if (!ago) return L.memUpdatedUnknown;
  return fmt(L.memUpdatedAgo, { ago });
}

export interface LineDiffLabel {
  /** e.g. `+42` (green). */
  added: string;
  /** e.g. `−7` with a real U+2212 minus (red). */
  removed: string;
  /** `0/0`: the working copy matches HEAD, which reads better as words than as `+0 −0`. */
  clean: boolean;
}

/**
 * Real per-file git line counts (`memory.file.lineDiff`) → display chips. Returns `null` when the
 * backend reports no diff data (git unavailable / not a repo / binary) so the caller falls back to an
 * honest placeholder — NEVER a fabricated `+42 −7`. `0/0` (a clean file) is real data and rendered.
 */
export function formatLineDiff(d: MemoryLineDiff | null | undefined): LineDiffLabel | null {
  if (!d) return null;
  return { added: `+${d.added}`, removed: `−${d.removed}`, clean: d.added === 0 && d.removed === 0 };
}

export interface BlameRow {
  /** 1-based line number. */
  lineNo: number;
  /** The raw content of the line. */
  text: string;
  /** Real short commit hash (from `git blame`), or null when this line has no blame attribution. */
  commit: string | null;
  /** Task ref parsed from the commit subject, or null (honest — never fabricated). */
  taskRef: string | null;
  /** True when this line begins a new commit run (drives the per-commit highlight band + gutter label). */
  groupStart: boolean;
}

/**
 * Zip the file's content lines with the real per-line `git blame` attribution for the逐行 highlight
 * pane. Returns `null` when `blame` is null/undefined (git unavailable / not a repo / binary) so the
 * caller falls back to an honest placeholder — NEVER a fabricated attribution. A line with no matching
 * blame entry gets `commit: null` (honest), and `groupStart` is true at every commit boundary.
 */
export function groupBlame(
  blame: MemoryBlameLine[] | null | undefined,
  content: string,
): BlameRow[] | null {
  if (!blame) return null;
  const byLine = new Map<number, MemoryBlameLine>();
  for (const b of blame) byLine.set(b.line, b);

  // Split into lines; drop the single trailing empty element produced by a final newline so a
  // git-style N-line file yields N rows (not a phantom blank).
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  let prevCommit: string | null | undefined = undefined;
  return lines.map((text, i) => {
    const lineNo = i + 1;
    const b = byLine.get(lineNo) ?? null;
    const commit = b ? b.commit : null;
    const groupStart = commit !== prevCommit;
    prevCommit = commit;
    return { lineNo, text, commit, taskRef: b ? b.taskRef : null, groupStart };
  });
}

const KIND_LABEL: Record<MemoryKind, keyof Vocab> = {
  experiment: 'memKindExperiment',
  knowledge: 'memKindKnowledge',
  pattern: 'memKindPattern',
};

const STATUS_LABEL: Record<MemoryStatusKey, keyof Vocab> = {
  active: 'memStatusActive',
  valid: 'memStatusValid',
  partial: 'memStatusPartial',
  challenged: 'memStatusChallenged',
  corrected: 'memStatusCorrected',
  superseded: 'memStatusSuperseded',
  deprecated: 'memStatusDeprecated',
  refined: 'memStatusRefined',
  stale: 'memStatusStale',
  invalidated: 'memStatusInvalidated',
};

/** The property line's first word: a known kind in the reader's language, else the declared value. */
export function kindLabel(doc: Pick<MemoryDoc, 'kind' | 'kindRaw'>, L: Vocab): string | null {
  return doc.kind ? L[KIND_LABEL[doc.kind]] : doc.kindRaw;
}

/** A known status in the reader's language (its target id appended), else the status as written. */
export function statusLabel(status: MemoryDocStatus, L: Vocab): string {
  if (!status.key) return status.raw;
  const word = L[STATUS_LABEL[status.key]];
  return status.ref ? `${word} ${status.ref}` : word;
}
