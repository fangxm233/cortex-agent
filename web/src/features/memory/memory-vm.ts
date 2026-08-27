// input:  Shared memory-tree facts plus diff and blame DTOs
// output: Hierarchical desktop rows, diff styles, and blame presentation models
// pos:    Pure view model for the desktop memory browser
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import type { MemoryLineDiff, MemoryBlameLine } from '@cortex-agent/ui-contract';
import type { MemoryTreeFacts } from './memory-tree';

// Pure view-model helpers for the memory viewer 7b center view (prototype.dc.html L658–719). No JSX,
// no fabricated data. Project selection is owned separately by features/projects.

export interface TreeRow {
  /** Display name — dirs carry a trailing slash. */
  name: string;
  kind: 'file' | 'dir';
  /** memory.file path for a selectable top-level or nested file; null for a directory row. */
  path: string | null;
  /** 0 for top-level files/directories, 1 for entries nested under a directory. */
  depth: 0 | 1;
  selectable: boolean;
  selected: boolean;
  /** Right-aligned mono count — the real dir `entryCount`; null for files (no line-count backend). */
  right: string | null;
}

/**
 * Tree rows for the 200px browser: selectable top-level files followed by each directory and its real
 * selectable entries. Directory rows retain the server count but remain labels, while nested rows use
 * canonical memory.file paths from the shared facts. Files carry no fabricated line-count chip.
 */
export function buildTreeRows(facts: MemoryTreeFacts, selectedPath: string | null): TreeRow[] {
  const topLevelRows: TreeRow[] = facts.topLevelFiles.map((file) => ({
    name: file.name,
    kind: 'file',
    path: file.path,
    depth: 0,
    selectable: true,
    selected: file.path === selectedPath,
    right: null,
  }));
  const dirRows = facts.dirs.flatMap<TreeRow>((dir) => [
    {
      name: `${dir.name}/`,
      kind: 'dir',
      path: null,
      depth: 0,
      selectable: false,
      selected: false,
      right: String(dir.entryCount),
    },
    ...dir.entries.map<TreeRow>((file) => ({
      name: file.name,
      kind: 'file',
      path: file.path,
      depth: 1,
      selectable: true,
      selected: file.path === selectedPath,
      right: null,
    })),
  ]);
  return [...topLevelRows, ...dirRows];
}

/** Default selected file = first top-level file, otherwise the first nested entry. */
export function pickDefaultPath(facts: MemoryTreeFacts): string | null {
  return facts.firstFile?.path ?? null;
}

/** `updated 2m ago` from an ISO timestamp; `updated —` when missing/unparseable. */
export function relTimeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return 'updated —';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'updated —';
  const ms = Math.max(0, now - t);
  const m = Math.round(ms / 60000);
  if (m < 1) return 'updated <1m ago';
  if (m < 60) return `updated ${m}m ago`;
  const h = Math.round(ms / 3600000);
  if (h < 24) return `updated ${h}h ago`;
  return `updated ${Math.round(ms / 86400000)}d ago`;
}

export interface DiffToggleStyle {
  label: string;
  color: string;
  bg: string;
  border: string;
}

/**
 * The diff-toggle pill's two visual states, verbatim from the prototype bindings (L2376/L2776):
 * ON → filled blue "Viewing diff"; OFF → light-outline "Diff hidden".
 */
export function diffToggle(on: boolean): DiffToggleStyle {
  return on
    ? { label: 'Viewing diff', color: 'var(--ink-solid-fg)', bg: 'var(--proto-accent)', border: 'var(--proto-accent)' }
    : { label: 'Diff hidden', color: 'var(--proto-accent)', bg: 'var(--proto-card)', border: 'var(--proto-accent-border)' };
}

export interface LineDiffLabel {
  /** e.g. `+42` (green). */
  added: string;
  /** e.g. `−7` with a real U+2212 minus (red). */
  removed: string;
}

/**
 * Real per-file git line counts (`memory.file.lineDiff`) → display chips. Returns `null` when the
 * backend reports no diff data (git unavailable / not a repo / binary) so the caller falls back to an
 * honest placeholder — NEVER a fabricated `+42 −7`. `0/0` (a clean file) is real data and rendered.
 */
export function formatLineDiff(d: MemoryLineDiff | null | undefined): LineDiffLabel | null {
  if (!d) return null;
  return { added: `+${d.added}`, removed: `−${d.removed}` };
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
