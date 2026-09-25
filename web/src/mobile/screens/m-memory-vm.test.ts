import { describe, it, expect } from 'vitest';
import type { MemoryTree } from '@cortex-agent/ui-contract';
import { deriveMemoryTreeFacts, type MemoryTreeFacts } from '@/features/memory/memory-tree';
import { buildMMemoryVm } from './m-memory-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

// Neutral fixtures (守则11): project 'atlas', files NOTES.md/AGENTS.md, dirs experiments/knowledge —
// NOT the scheme's EXP-023/PAT-007 mocks.
function facts(p: Partial<MemoryTree> = {}): MemoryTreeFacts {
  return deriveMemoryTreeFacts({
    projectId: p.projectId ?? 'atlas',
    files: p.files ?? [],
    dirs: p.dirs ?? [],
  });
}

describe('buildMMemoryVm', () => {
  it('undefined tree → empty vm (loading-safe)', () => {
    const vm = buildMMemoryVm(undefined, NOW);
    expect(vm.isEmpty).toBe(true);
    expect(vm.fileCount).toBe(0);
    expect(vm.core).toEqual([]);
    expect(vm.dirs).toEqual([]);
  });

  it('fileCount = top-level files + Σ dir entryCount (honest total memory files)', () => {
    const vm = buildMMemoryVm(
      facts({
        files: [
          { name: 'AGENTS.md', sizeBytes: 1, modifiedAt: new Date(NOW).toISOString() },
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
