import type { NoteInfo } from '@cortex-agent/ui-contract';
import { buildNotesVm, type NotesVm } from '@/features/notes/notes-vm';

export type MNotesVm = NotesVm;

export function buildMNotesVm(
  notes: NoteInfo[],
  now: number,
  lang: 'en' | 'zh',
): MNotesVm {
  const vm = buildNotesVm(notes, now, lang);
  return { ...vm, previews: vm.active.slice(0, 2) };
}
