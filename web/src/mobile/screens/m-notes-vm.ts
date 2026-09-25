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
