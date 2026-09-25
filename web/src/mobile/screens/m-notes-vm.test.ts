import { describe, expect, it } from 'vitest';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { buildMNotesVm } from './m-notes-vm';

function note(id: string, completed = false): NoteInfo {
  return {
    id,
    text: `${id} reminder`,
    completed,
    createdAt: '2026-07-29T17:41:00.000Z',
    updatedAt: '2026-07-29T17:41:00.000Z',
    completedAt: completed ? '2026-07-29T17:50:00.000Z' : null,
  };
}

describe('buildMNotesVm', () => {
  it('counts only active notes and limits the project-card preview to two', () => {
    const vm = buildMNotesVm([note('a'), note('b'), note('c'), note('done', true)], Date.parse('2026-07-29T18:00:00Z'), 'zh');
    expect(vm.activeCount).toBe(3);
    expect(vm.completedCount).toBe(1);
    expect(vm.previews.map((row) => row.id)).toEqual(['a', 'b']);
    expect(vm.completed.map((row) => row.id)).toEqual(['done']);
  });
});
