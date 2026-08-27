// input:  memory tree, diff, and blame DTOs
// output: memory rows, diff styles, and blame presentation models
// pos:    Pure view model for the desktop memory browser
// >>> If I am updated, update my header comment and CORTEX.md <<<
import type { MemoryTree, MemoryLineDiff, MemoryBlameLine } from '@cortex-agent/ui-contract';

// Pure view-model helpers for the memory viewer 7b center view (prototype.dc.html L658–719). No JSX,
// no fabricated data. Project selection is owned separately by features/projects.

export interface TreeRow {
  /** Display name — dirs carry a trailing slash. */
  name: string;
  kind: 'file' | 'dir';
  /** memory.file path for a selectable file, else null (dirs cannot be listed — no dir scope). */
  path: string | null;
  selectable: boolean;
  selected: boolean;
  /** Right-aligned mono count — the real dir `entryCount`; null for files (no line-count backend). */
  right: string | null;
}

/**
 * Tree rows for the 200px file tree: the real top-level files (selectable → memory.file) followed by
 * the real memory dirs with their entryCount. Dirs are NON-selectable: the memory.tree scope returns
 * only dir names + counts, not their entries, so nested files cannot be enumerated (flagged gap). File
 * rows carry NO right-hand chip — the prototype's `≤120L`/`9` are mock line counts with no backend.
 */
export function buildTreeRows(tree: MemoryTree, selectedPath: string | null): TreeRow[] {
  const files: TreeRow[] = tree.files.map((f) => ({
    name: f.name,
    kind: 'file',
    path: f.name,
    selectable: true,
    selected: f.name === selectedPath,
    right: null,
  }));
  const dirs: TreeRow[] = tree.dirs.map((d) => ({
    name: `${d.name}/`,
    kind: 'dir',
    path: null,
    selectable: false,
    selected: false,
    right: String(d.entryCount),
  }));
  return [...files, ...dirs];
}

/** Default selected file = the first top-level file, else null (nothing to render). */
export function pickDefaultPath(tree: MemoryTree): string | null {
  return tree.files[0]?.name ?? null;
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
