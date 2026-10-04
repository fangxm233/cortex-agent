import type { NoteInfo } from '@cortex-agent/ui-contract';
import { buildNotesVm, type NotesTimeWords, type NotesVm } from '@/features/notes/notes-vm';

export type MNotesVm = NotesVm;

export function buildMNotesVm(
  notes: NoteInfo[],
  now: number,
  L: NotesTimeWords,
): MNotesVm {
  const vm = buildNotesVm(notes, now, L);
  return { ...vm, previews: vm.active.slice(0, 2) };
}
