// input:  NoteInfo fixtures, local timezone and view-model helpers
// output: grouping, local timestamps and shortcut regressions
// pos:    Tests shared project notes presentation rules
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { NoteInfo } from '@cortex-agent/ui-contract';
import { buildNotesVm, formatNoteTime, isNotesShortcut } from './notes-vm';

const NOW = Date.parse('2026-07-29T18:00:00.000Z');

function withTimeZone<T>(timeZone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

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
    ], NOW, 'en');
    expect(vm.active.map((row) => row.id)).toEqual(['a', 'b']);
    expect(vm.completed.map((row) => row.id)).toEqual(['c']);
    expect(vm.activeCount).toBe(2);
    expect(vm.completedCount).toBe(1);
    expect(vm.previews.map((row) => row.id)).toEqual(['a', 'b']);
  });
});

describe('formatNoteTime', () => {
  it('formats same-day time, yesterday and older days without inventing dates', () => {
    withTimeZone('UTC', () => {
      expect(formatNoteTime('2026-07-29T17:41:00.000Z', NOW, 'en')).toBe('17:41');
      expect(formatNoteTime('2026-07-28T17:41:00.000Z', NOW, 'en')).toBe('yesterday');
      expect(formatNoteTime('2026-07-26T17:41:00.000Z', NOW, 'en')).toBe('3d');
      expect(formatNoteTime('bad', NOW, 'en')).toBe('—');
      expect(formatNoteTime('2026-07-28T17:41:00.000Z', NOW, 'zh')).toBe('昨天');
    });
  });

  it('uses the device timezone for the clock and same-day boundary', () => {
    withTimeZone('America/Denver', () => {
      expect(formatNoteTime('2026-07-29T17:41:00.000Z', NOW, 'en')).toBe('11:41');
      expect(formatNoteTime('2026-07-29T23:30:00.000Z', Date.parse('2026-07-30T05:00:00.000Z'), 'en')).toBe('17:30');
    });
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
