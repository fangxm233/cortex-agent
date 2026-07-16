import { describe, it, expect } from 'vitest';
import type { MemoryTree } from '@cortex-agent/ui-contract';
import { buildMMemoryVm } from './m-memory-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

// Neutral fixtures (守则11): project 'atlas', files NOTES.md/CORTEX.md, dirs experiments/knowledge —
// NOT the scheme's EXP-023/PAT-007 mocks.
function tree(p: Partial<MemoryTree> = {}): MemoryTree {
  return {
    projectId: p.projectId ?? 'atlas',
    files: p.files ?? [],
    dirs: p.dirs ?? [],
  };
}

describe('buildMMemoryVm', () => {
  it('empty tree → isEmpty, zero fileCount, no rows', () => {
    const vm = buildMMemoryVm(tree(), NOW);
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

  it('maps top-level files to core rows with real relative modifiedAt, input order', () => {
    const vm = buildMMemoryVm(
      tree({
        files: [
          { name: 'CORTEX.md', sizeBytes: 100, modifiedAt: new Date(NOW - 12 * 60_000).toISOString() },
          { name: 'NOTES.md', sizeBytes: 50, modifiedAt: new Date(NOW - 2 * 3600_000).toISOString() },
        ],
      }),
      NOW,
    );
    expect(vm.core.map((r) => r.name)).toEqual(['CORTEX.md', 'NOTES.md']);
    expect(vm.core[0].time).toBe('12 分钟');
    expect(vm.core[1].time).toBe('2 小时');
  });

  it('maps dirs to cards preserving name + real entryCount, input order', () => {
    const vm = buildMMemoryVm(
      tree({
        dirs: [
          { name: 'experiments', entryCount: 9 },
          { name: 'knowledge', entryCount: 3 },
        ],
      }),
      NOW,
    );
    expect(vm.dirs).toEqual([
      { name: 'experiments', entryCount: 9 },
      { name: 'knowledge', entryCount: 3 },
    ]);
  });

  it('fileCount = top-level files + Σ dir entryCount (honest total memory files)', () => {
    const vm = buildMMemoryVm(
      tree({
        files: [
          { name: 'CORTEX.md', sizeBytes: 1, modifiedAt: new Date(NOW).toISOString() },
          { name: 'NOTES.md', sizeBytes: 1, modifiedAt: new Date(NOW).toISOString() },
        ],
        dirs: [
          { name: 'experiments', entryCount: 9 },
          { name: 'knowledge', entryCount: 3 },
        ],
      }),
      NOW,
    );
    expect(vm.fileCount).toBe(14); // 2 top-level + 9 + 3
    expect(vm.isEmpty).toBe(false);
  });
});
