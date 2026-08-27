// input:  MemoryTree DTOs with top-level files and directory entries
// output: Canonical desktop/mobile memory-tree facts and file paths
// pos:    Shared hierarchical memory-tree mapping specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it } from 'vitest';
import type { MemoryFileEntry, MemoryTree } from '@cortex-agent/ui-contract';
import { deriveMemoryTreeFacts } from './memory-tree';

function file(name: string, modifiedAt = '2026-07-15T12:00:00.000Z'): MemoryFileEntry {
  return { name, sizeBytes: 10, modifiedAt };
}

function tree(overrides: Partial<MemoryTree> = {}): MemoryTree {
  return {
    projectId: 'atlas',
    files: [file('CORTEX.md')],
    dirs: [
      { name: 'experiments', entryCount: 2, entries: [file('EXP-001.md'), file('EXP-002.md')] },
      { name: 'knowledge', entryCount: 1, entries: [file('K-001.md')] },
    ],
    ...overrides,
  };
}

describe('deriveMemoryTreeFacts', () => {
  it('maps top-level and nested file paths once while retaining directory order and counts', () => {
    const facts = deriveMemoryTreeFacts(tree());

    expect(facts.topLevelFiles.map((entry) => entry.path)).toEqual(['CORTEX.md']);
    expect(facts.dirs.map((dir) => dir.name)).toEqual(['experiments', 'knowledge']);
    expect(facts.dirs.map((dir) => dir.entryCount)).toEqual([2, 1]);
    expect(facts.dirs[0].entries.map((entry) => entry.path)).toEqual([
      'experiments/EXP-001.md',
      'experiments/EXP-002.md',
    ]);
    expect(facts.dirs[1].entries[0].path).toBe('knowledge/K-001.md');
    expect(facts.fileCount).toBe(4);
  });

  it('uses the first top-level file as the first file', () => {
    expect(deriveMemoryTreeFacts(tree()).firstFile?.path).toBe('CORTEX.md');
  });

  it('falls back to the first nested file when there is no top-level file', () => {
    const dirs = [
      { name: 'empty', entryCount: 0, entries: [] },
      { name: 'knowledge', entryCount: 1, entries: [file('K-001.md')] },
    ];
    expect(deriveMemoryTreeFacts(tree({ files: [], dirs })).firstFile?.path).toBe('knowledge/K-001.md');
  });

  it('returns loading-safe empty facts when the tree is absent', () => {
    expect(deriveMemoryTreeFacts(undefined)).toEqual({
      topLevelFiles: [],
      dirs: [],
      fileCount: 0,
      firstFile: null,
    });
  });
});
