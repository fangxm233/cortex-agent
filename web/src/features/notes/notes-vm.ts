// input:  NoteInfo records, current time and language
// output: grouped note rows, summaries and shortcut predicates
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

export function formatNoteTime(iso: string, now: number, lang: 'en' | 'zh'): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return '—';
  const nowIso = new Date(now).toISOString();
  if (iso.slice(0, 10) === nowIso.slice(0, 10)) return iso.slice(11, 16);
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
