import type { NoteInfo } from '@cortex-agent/ui-contract';
import { fmt, type Vocab } from '@/i18n';

export type NotesTimeWords = Pick<Vocab, 'noteYesterday' | 'noteDaysAgo'>;

export interface NoteRowVm extends NoteInfo {
  timeLabel: string;
}

export interface NotesVm {
  active: NoteRowVm[];
  completed: NoteRowVm[];
  previews: NoteRowVm[];
  activeCount: number;
  completedCount: number;
}

interface ShortcutLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function relativeDayLabel(days: number, L: NotesTimeWords): string {
  if (days === 1) return L.noteYesterday;
  return fmt(L.noteDaysAgo, { n: Math.max(2, days) });
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function localClockLabel(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatNoteTime(iso: string, now: number, L: NotesTimeWords): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '—';
  const created = new Date(timestamp);
  if (isSameLocalDay(created, new Date(now))) return localClockLabel(created);
  const days = Math.max(1, Math.floor((now - timestamp) / 86_400_000));
  return relativeDayLabel(days, L);
}

function toRow(note: NoteInfo, now: number, L: NotesTimeWords): NoteRowVm {
  return { ...note, timeLabel: formatNoteTime(note.createdAt, now, L) };
}

export function buildNotesVm(notes: NoteInfo[], now: number, L: NotesTimeWords): NotesVm {
  const rows = notes.map((note) => toRow(note, now, L));
  const active = rows.filter((note) => !note.completed);
  const completed = rows.filter((note) => note.completed);
  return {
    active,
    completed,
    previews: active.slice(0, 3),
    activeCount: active.length,
    completedCount: completed.length,
  };
}

export function isNotesShortcut(event: ShortcutLike): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n';
}
