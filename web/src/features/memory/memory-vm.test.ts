import { describe, it, expect } from 'vitest';
import type { MemoryTree, MemoryBlameLine } from '@cortex-agent/ui-contract';
import { en, zh } from '@/i18n';
import { deriveMemoryTreeFacts } from './memory-tree';
import { parseStatus } from './memory-doc';
import {
  buildTreeRows,
  groupBlame,
  formatLineDiff,
  hasRecentChange,
  isRecentChange,
  kindLabel,
  statusLabel,
  DEFAULT_MEMORY_MODE,
  RECENT_CHANGE_MS,
} from './memory-vm';

function tree(over: Partial<MemoryTree> = {}): MemoryTree {
  return {
    projectId: 'my-project',
    files: [
      { name: 'mission.md', sizeBytes: 100, modifiedAt: '2026-07-01T00:00:00.000Z' },
      { name: 'STATUS.md', sizeBytes: 200, modifiedAt: '2026-07-02T00:00:00.000Z' },
    ],
    dirs: [
      {
        name: 'experiments',
        entryCount: 2,
        entries: [
          { name: 'EXP-001.md', sizeBytes: 30, modifiedAt: '2026-07-03T00:00:00.000Z' },
          { name: 'EXP-002.md', sizeBytes: 40, modifiedAt: '2026-07-04T00:00:00.000Z' },
        ],
      },
      {
        name: 'knowledge',
        entryCount: 1,
        entries: [{ name: 'K-001.md', sizeBytes: 50, modifiedAt: '2026-07-05T00:00:00.000Z' }],
      },
    ],
    ...over,
  };
}

describe('buildTreeRows', () => {
  it('lists top-level files, then each non-selectable directory and its selectable nested files', () => {
    const rows = buildTreeRows(deriveMemoryTreeFacts(tree()), 'experiments/EXP-002.md');
    expect(rows.map((r) => r.name)).toEqual([
      'mission.md',
      'STATUS.md',
      'experiments',
      'EXP-001.md',
      'EXP-002.md',
      'knowledge',
      'K-001.md',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'file', path: 'mission.md', selectable: true, depth: 0 });
    expect(rows[0].right).toBeNull(); // no fabricated line-count chip
    expect(rows[2]).toMatchObject({ kind: 'dir', path: null, selectable: false, right: '2', depth: 0, expanded: true });
    expect(rows[0].expanded).toBeNull();
    expect(rows[3]).toMatchObject({
      kind: 'file',
      path: 'experiments/EXP-001.md',
      selectable: true,
      depth: 1,
    });
  });

  it('marks a nested selected file row', () => {
    const rows = buildTreeRows(deriveMemoryTreeFacts(tree()), 'experiments/EXP-002.md');
    expect(rows.find((r) => r.path === 'experiments/EXP-002.md')!.selected).toBe(true);
    expect(rows.find((r) => r.path === 'mission.md')!.selected).toBe(false);
  });

  it('folds a collapsed directory to its row, keeping the server count', () => {
    const rows = buildTreeRows(deriveMemoryTreeFacts(tree()), null, { collapsed: new Set(['experiments']) });
    expect(rows.map((r) => r.name)).toEqual(['mission.md', 'STATUS.md', 'experiments', 'knowledge', 'K-001.md']);
    expect(rows[2]).toMatchObject({ expanded: false, right: '2' });
  });

  it('marks files whose real mtime is inside the last 24 hours, and none without a clock', () => {
    const now = Date.parse('2026-07-05T06:00:00.000Z');
    const facts = deriveMemoryTreeFacts(tree());
    const rows = buildTreeRows(facts, null, { now });
    // EXP-002 changed 30h before `now`, K-001 6h before.
    expect(rows.filter((r) => r.recent).map((r) => r.path)).toEqual(['knowledge/K-001.md']);
    expect(rows.find((r) => r.kind === 'dir')!.recent).toBe(false);
    expect(buildTreeRows(facts, null).some((r) => r.recent)).toBe(false);
    expect(hasRecentChange(facts, now)).toBe(true);
    expect(hasRecentChange(facts, Date.parse('2026-08-01T00:00:00.000Z'))).toBe(false);
  });
});

describe('isRecentChange', () => {
  const now = Date.parse('2026-07-04T12:00:00.000Z');
  it('is true strictly inside the window and false for missing or unparseable times', () => {
    expect(isRecentChange(new Date(now - RECENT_CHANGE_MS + 1000).toISOString(), now)).toBe(true);
    expect(isRecentChange(new Date(now - RECENT_CHANGE_MS).toISOString(), now)).toBe(false);
    expect(isRecentChange(null, now)).toBe(false);
    expect(isRecentChange('not a date', now)).toBe(false);
  });
});

describe('viewer mode', () => {
  it('opens on the rendered document, not the per-line history', () => {
    expect(DEFAULT_MEMORY_MODE).toBe('read');
  });
});

describe('formatLineDiff', () => {
  it('formats real counts with a true minus and flags a clean file', () => {
    expect(formatLineDiff({ added: 3, removed: 1 })).toEqual({ added: '+3', removed: '−1', clean: false });
    expect(formatLineDiff({ added: 0, removed: 0 })!.clean).toBe(true);
    expect(formatLineDiff(null)).toBeNull();
  });
});

describe('property line labels', () => {
  it('names known kinds and statuses in the reader language, else shows the value as written', () => {
    expect(kindLabel({ kind: 'experiment', kindRaw: null }, zh)).toBe('实验');
    expect(kindLabel({ kind: null, kindRaw: 'retro' }, en)).toBe('retro');
    expect(kindLabel({ kind: null, kindRaw: null }, en)).toBeNull();
    expect(statusLabel(parseStatus('valid')!, zh)).toBe('有效');
    expect(statusLabel(parseStatus('superseded:EXP-012')!, en)).toBe('Superseded EXP-012');
    expect(statusLabel(parseStatus('on-hold')!, en)).toBe('on-hold');
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
});
