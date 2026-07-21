import { describe, it, expect } from 'vitest';
import type { MemoryTree, MemoryBlameLine } from '@cortex-agent/ui-contract';
import {
  buildTreeRows,
  pickDefaultPath,
  relTimeAgo,
  diffToggle,
  formatLineDiff,
  groupBlame,
} from './memory-vm';

function tree(over: Partial<MemoryTree> = {}): MemoryTree {
  return {
    projectId: 'my-project',
    files: [
      { name: 'mission.md', sizeBytes: 100, modifiedAt: '2026-07-01T00:00:00.000Z' },
      { name: 'STATUS.md', sizeBytes: 200, modifiedAt: '2026-07-02T00:00:00.000Z' },
    ],
    dirs: [
      { name: 'experiments', entryCount: 23, entries: [] },
      { name: 'knowledge', entryCount: 12, entries: [] },
    ],
    ...over,
  };
}

describe('buildTreeRows', () => {
  it('lists files first (selectable, path=name) then dirs (non-selectable, count)', () => {
    const rows = buildTreeRows(tree(), 'STATUS.md');
    expect(rows.map((r) => r.name)).toEqual([
      'mission.md',
      'STATUS.md',
      'experiments/',
      'knowledge/',
    ]);
    const file = rows[0];
    expect(file).toMatchObject({ kind: 'file', path: 'mission.md', selectable: true });
    expect(file.right).toBeNull(); // no fabricated line-count chip

    const dir = rows[2];
    expect(dir).toMatchObject({ kind: 'dir', path: null, selectable: false, right: '23' });
  });

  it('marks the selected file row', () => {
    const rows = buildTreeRows(tree(), 'STATUS.md');
    expect(rows.find((r) => r.name === 'STATUS.md')!.selected).toBe(true);
    expect(rows.find((r) => r.name === 'mission.md')!.selected).toBe(false);
  });

  it('appends a trailing slash to dir names only', () => {
    const rows = buildTreeRows(tree(), null);
    expect(rows.find((r) => r.kind === 'dir')!.name.endsWith('/')).toBe(true);
    expect(rows.find((r) => r.kind === 'file')!.name.endsWith('/')).toBe(false);
  });
});

describe('pickDefaultPath', () => {
  it('returns the first file path, else null', () => {
    expect(pickDefaultPath(tree())).toBe('mission.md');
    expect(pickDefaultPath(tree({ files: [] }))).toBeNull();
  });
});

describe('relTimeAgo', () => {
  const now = Date.parse('2026-07-07T12:00:00.000Z');
  it('formats sub-minute / minutes / hours / days', () => {
    expect(relTimeAgo('2026-07-07T11:59:40.000Z', now)).toBe('updated <1m ago');
    expect(relTimeAgo('2026-07-07T11:45:00.000Z', now)).toBe('updated 15m ago');
    expect(relTimeAgo('2026-07-07T09:00:00.000Z', now)).toBe('updated 3h ago');
    expect(relTimeAgo('2026-07-04T12:00:00.000Z', now)).toBe('updated 3d ago');
  });
  it('handles missing / unparseable input', () => {
    expect(relTimeAgo(null, now)).toBe('updated —');
    expect(relTimeAgo('not-a-date', now)).toBe('updated —');
  });
});

describe('diffToggle', () => {
  it('is the filled blue pill when on (Viewing diff)', () => {
    expect(diffToggle(true)).toEqual({
      label: 'Viewing diff',
      color: '#fff',
      bg: '#4655D4',
      border: '#4655D4',
    });
  });
  it('is the outline pill when off (Diff hidden)', () => {
    expect(diffToggle(false)).toEqual({
      label: 'Diff hidden',
      color: '#4655D4',
      bg: '#fff',
      border: '#C9CFF2',
    });
  });
});

describe('formatLineDiff', () => {
  it('formats real counts as +N / −M chips (U+2212 minus)', () => {
    expect(formatLineDiff({ added: 42, removed: 7 })).toEqual({ added: '+42', removed: '−7' });
  });
  it('renders a clean file (0/0) as real data, not a placeholder', () => {
    expect(formatLineDiff({ added: 0, removed: 0 })).toEqual({ added: '+0', removed: '−0' });
  });
  it('returns null for null/undefined so the caller shows an honest placeholder (never fabricated)', () => {
    expect(formatLineDiff(null)).toBeNull();
    expect(formatLineDiff(undefined)).toBeNull();
  });
});

describe('groupBlame', () => {
  const blame: MemoryBlameLine[] = [
    { line: 1, commit: 'aaaa1111', taskRef: 'ab12' },
    { line: 2, commit: 'aaaa1111', taskRef: 'ab12' },
    { line: 3, commit: 'bbbb2222', taskRef: null },
  ];

  it('zips content lines with blame, flagging the first line of each commit run', () => {
    const rows = groupBlame(blame, 'one\ntwo\nthree\n');
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.lineNo)).toEqual([1, 2, 3]);
    expect(rows!.map((r) => r.text)).toEqual(['one', 'two', 'three']);
    expect(rows!.map((r) => r.groupStart)).toEqual([true, false, true]);
    expect(rows![0]).toMatchObject({ commit: 'aaaa1111', taskRef: 'ab12' });
    expect(rows![2]).toMatchObject({ commit: 'bbbb2222', taskRef: null });
  });

  it('returns null when blame is null (caller shows honest placeholder, never fabricated)', () => {
    expect(groupBlame(null, 'one\ntwo\n')).toBeNull();
    expect(groupBlame(undefined, 'one\ntwo\n')).toBeNull();
  });

  it('tolerates a content/blame length mismatch (missing blame → null attribution)', () => {
    const rows = groupBlame([{ line: 1, commit: 'aaaa1111', taskRef: null }], 'one\ntwo\n');
    expect(rows!.map((r) => r.lineNo)).toEqual([1, 2]);
    expect(rows![0]).toMatchObject({ commit: 'aaaa1111', groupStart: true });
    expect(rows![1]).toMatchObject({ commit: null, taskRef: null, groupStart: true });
  });

  it('drops a single trailing empty line from the final newline (no phantom blank row)', () => {
    const rows = groupBlame(blame, 'one\ntwo\nthree\n');
    expect(rows!.length).toBe(3);
  });
});
