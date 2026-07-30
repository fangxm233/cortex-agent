// input:  NoteInfo records, current time, device timezone and language
// output: grouped note rows, local time labels and shortcuts
// pos:    Shared pure view model for project notes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import type { NoteInfo } from '@cortex-agent/ui-contract';

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

function relativeDayLabel(days: number, lang: 'en' | 'zh'): string {
  if (days === 1) return lang === 'zh' ? '昨天' : 'yesterday';
  return lang === 'zh' ? `${Math.max(2, days)} 天前` : `${Math.max(2, days)}d`;
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

export function formatNoteTime(iso: string, now: number, lang: 'en' | 'zh'): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '—';
  const created = new Date(timestamp);
  if (isSameLocalDay(created, new Date(now))) return localClockLabel(created);
  const days = Math.max(1, Math.floor((now - timestamp) / 86_400_000));
  return relativeDayLabel(days, lang);
}

function toRow(note: NoteInfo, now: number, lang: 'en' | 'zh'): NoteRowVm {
  return { ...note, timeLabel: formatNoteTime(note.createdAt, now, lang) };
}

export function buildNotesVm(notes: NoteInfo[], now: number, lang: 'en' | 'zh'): NotesVm {
  const rows = notes.map((note) => toRow(note, now, lang));
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
