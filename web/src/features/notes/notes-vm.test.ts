import { describe, expect, it } from 'vitest';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { buildNotesVm, isNotesShortcut, notesSheetPlacement } from './notes-vm';
import { en } from '@/i18n';

const NOW = Date.parse('2026-07-29T18:00:00.000Z');

function note(id: string, completed: boolean, createdAt: string): NoteInfo {
  return {
    id,
    text: `${id} text`,
    completed,
    createdAt,
    updatedAt: createdAt,
    completedAt: completed ? createdAt : null,
  };
}

describe('buildNotesVm', () => {
  it('keeps active and completed notes separate with active-only count and previews', () => {
    const vm = buildNotesVm([
      note('a', false, '2026-07-29T17:41:00.000Z'),
      note('b', false, '2026-07-28T17:41:00.000Z'),
      note('c', true, '2026-07-27T17:41:00.000Z'),
    ], NOW, en);
    expect(vm.active.map((row) => row.id)).toEqual(['a', 'b']);
    expect(vm.completed.map((row) => row.id)).toEqual(['c']);
    expect(vm.activeCount).toBe(2);
    expect(vm.completedCount).toBe(1);
    expect(vm.previews.map((row) => row.id)).toEqual(['a', 'b']);
  });
});

describe('isNotesShortcut', () => {
  it('accepts command/control-shift-N and rejects plain new-session shortcuts', () => {
    expect(isNotesShortcut({ key: 'N', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe(true);
    expect(isNotesShortcut({ key: 'n', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false })).toBe(true);
    expect(isNotesShortcut({ key: 'n', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false })).toBe(false);
    expect(isNotesShortcut({ key: 'n', metaKey: true, ctrlKey: false, shiftKey: true, altKey: true })).toBe(false);
  });
});

describe('notesSheetPlacement', () => {
  const pane = { top: 60, right: 1400, bottom: 900, width: 1000 };

  it('hangs under the trigger with right edges aligned', () => {
    expect(notesSheetPlacement(pane, { top: 71, right: 1330, bottom: 99, width: 28 })).toEqual({ top: 47, right: 70 });
  });

  it('keeps the sheet inside the pane', () => {
    expect(notesSheetPlacement(pane, { top: 71, right: 1405, bottom: 99, width: 28 }).right).toBe(12);
    expect(notesSheetPlacement(pane, { top: 71, right: 500, bottom: 99, width: 28 }).right).toBe(608);
  });

  it('falls back to the top-right corner without a trigger', () => {
    expect(notesSheetPlacement(pane, null)).toEqual({ top: 56, right: 12 });
  });
});
