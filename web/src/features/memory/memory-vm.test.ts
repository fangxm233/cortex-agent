// input:  Shared memory-tree facts plus diff and blame DTOs
// output: Desktop hierarchy, selection, and blame presentation regressions
// pos:    Desktop memory view-model specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { MemoryTree, MemoryBlameLine } from '@cortex-agent/ui-contract';
import { deriveMemoryTreeFacts } from './memory-tree';
import {
  buildTreeRows,
  pickDefaultPath,
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
      'experiments/',
      'EXP-001.md',
      'EXP-002.md',
      'knowledge/',
      'K-001.md',
    ]);
    expect(rows[0]).toMatchObject({ kind: 'file', path: 'mission.md', selectable: true, depth: 0 });
    expect(rows[0].right).toBeNull(); // no fabricated line-count chip
    expect(rows[2]).toMatchObject({ kind: 'dir', path: null, selectable: false, right: '2', depth: 0 });
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

  it('appends a trailing slash to dir names only', () => {
    const rows = buildTreeRows(deriveMemoryTreeFacts(tree()), null);
    expect(rows.find((r) => r.kind === 'dir')!.name.endsWith('/')).toBe(true);
    expect(rows.find((r) => r.kind === 'file')!.name.endsWith('/')).toBe(false);
  });
});

describe('pickDefaultPath', () => {
  it('returns the first top-level path, then the first nested path, else null', () => {
    expect(pickDefaultPath(deriveMemoryTreeFacts(tree()))).toBe('mission.md');
    expect(pickDefaultPath(deriveMemoryTreeFacts(tree({ files: [] })))).toBe('experiments/EXP-001.md');
    expect(pickDefaultPath(deriveMemoryTreeFacts(tree({ files: [], dirs: [] })))).toBeNull();
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
