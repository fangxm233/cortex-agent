// input:  Shared memory-tree facts and an injected clock
// output: Mobile accordion, time, count, and clean-read row regressions
// pos:    Mobile memory view-model specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import type { MemoryTree, MemoryFileEntry } from '@cortex-agent/ui-contract';
import { deriveMemoryTreeFacts, type MemoryTreeFacts } from '@/features/memory/memory-tree';
import { buildMMemoryVm } from './m-memory-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

// Neutral fixtures (守则11): project 'atlas', files NOTES.md/CORTEX.md, dirs experiments/knowledge —
// NOT the scheme's EXP-023/PAT-007 mocks.
function facts(p: Partial<MemoryTree> = {}): MemoryTreeFacts {
  return deriveMemoryTreeFacts({
    projectId: p.projectId ?? 'atlas',
    files: p.files ?? [],
    dirs: p.dirs ?? [],
  });
}

function entry(name: string, minsAgo = 0): MemoryFileEntry {
  return { name, sizeBytes: 10, modifiedAt: new Date(NOW - minsAgo * 60_000).toISOString() };
}

describe('buildMMemoryVm', () => {
  it('empty tree → isEmpty, zero fileCount, no rows', () => {
    const vm = buildMMemoryVm(facts(), NOW);
    expect(vm.isEmpty).toBe(true);
    expect(vm.fileCount).toBe(0);
    expect(vm.core).toEqual([]);
    expect(vm.dirs).toEqual([]);
  });

  it('undefined tree → empty vm (loading-safe)', () => {
    const vm = buildMMemoryVm(undefined, NOW);
    expect(vm.isEmpty).toBe(true);
    expect(vm.fileCount).toBe(0);
    expect(vm.core).toEqual([]);
    expect(vm.dirs).toEqual([]);
  });

  it('maps top-level files to core rows with project-relative paths in input order', () => {
    const vm = buildMMemoryVm(
      facts({
        files: [
          { name: 'CORTEX.md', sizeBytes: 100, modifiedAt: new Date(NOW - 12 * 60_000).toISOString() },
          { name: 'NOTES.md', sizeBytes: 50, modifiedAt: new Date(NOW - 2 * 3600_000).toISOString() },
        ],
      }),
      NOW,
    );
    expect(vm.core).toEqual([
      { name: 'CORTEX.md', path: 'CORTEX.md', time: '12 分钟' },
      { name: 'NOTES.md', path: 'NOTES.md', time: '2 小时' },
    ]); // Clean-read rows expose canonical path + time, never desktop diff/blame presentation.
  });

  it('maps dirs to cards with real entryCount + enumerated entries (path=<dir>/<name>), input order', () => {
    const vm = buildMMemoryVm(
      facts({
        dirs: [
          { name: 'experiments', entryCount: 2, entries: [entry('EXP-001.md', 5), entry('EXP-002.md', 90)] },
          { name: 'knowledge', entryCount: 1, entries: [entry('K-001.md', 0)] },
        ],
      }),
      NOW,
    );
    expect(vm.dirs.map((d) => d.name)).toEqual(['experiments', 'knowledge']);
    expect(vm.dirs.map((d) => d.entryCount)).toEqual([2, 1]);
    // Entries are enumerated with a project-root-relative path (<dir>/<name>).
    expect(vm.dirs[0].entries.map((e) => e.name)).toEqual(['EXP-001.md', 'EXP-002.md']);
    expect(vm.dirs[0].entries.map((e) => e.path)).toEqual([
      'experiments/EXP-001.md',
      'experiments/EXP-002.md',
    ]);
    expect(vm.dirs[1].entries[0].path).toBe('knowledge/K-001.md');
  });

  it('keeps a directory with an empty entries list as an honest empty accordion', () => {
    const vm = buildMMemoryVm(
      facts({ dirs: [{ name: 'patterns', entryCount: 0, entries: [] }] }),
      NOW,
    );
    expect(vm.dirs[0].entries).toEqual([]);
    expect(vm.dirs[0].entryCount).toBe(0);
  });

  it('fileCount = top-level files + Σ dir entryCount (honest total memory files)', () => {
    const vm = buildMMemoryVm(
      facts({
        files: [
          { name: 'CORTEX.md', sizeBytes: 1, modifiedAt: new Date(NOW).toISOString() },
          { name: 'NOTES.md', sizeBytes: 1, modifiedAt: new Date(NOW).toISOString() },
        ],
        dirs: [
          { name: 'experiments', entryCount: 9, entries: [] },
          { name: 'knowledge', entryCount: 3, entries: [] },
        ],
      }),
      NOW,
    );
    expect(vm.fileCount).toBe(14); // 2 top-level + 9 + 3
    expect(vm.isEmpty).toBe(false);
  });
});
