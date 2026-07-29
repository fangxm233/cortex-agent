// input:  NoteInfo records, current time and mobile language
// output: mobile note rows, counts and two-row project previews
// pos:    Pure view model for mobile project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { NoteInfo } from '@cortex-agent/ui-contract';
import { buildNotesVm, type NoteRowVm } from '@/features/notes/notes-vm';

export interface MNotesVm {
  active: NoteRowVm[];
  completed: NoteRowVm[];
  previews: NoteRowVm[];
  activeCount: number;
  completedCount: number;
}

export function buildMNotesVm(
  notes: NoteInfo[],
  now: number,
  lang: 'en' | 'zh',
): MNotesVm {
  const vm = buildNotesVm(notes, now, lang);
  return { ...vm, previews: vm.active.slice(0, 2) };
}
