// input:  publishSystemNotice call sites (system-notice.ts)
// output: recordSystemNotice / listSystemNotices / resetSystemNoticeHistory ring buffer
// pos:    In-process history of system notices backing the `system.notices` UI query. Module
//         singleton, capped at NOTICE_HISTORY_CAP entries — not persisted, cleared on restart.

export type SystemNoticeLevel = 'info' | 'warning' | 'error';

export interface SystemNoticeEntry {
  id: string;
  ts: string;
  level: SystemNoticeLevel;
  title?: string;
  text: string;
}

export const NOTICE_HISTORY_CAP = 50;

let history: SystemNoticeEntry[] = [];
let nextId = 1;

export function recordSystemNotice(entry: {
  level?: SystemNoticeLevel;
  text: string;
  title?: string;
}): void {
  history.unshift({
    id: `sn-${nextId++}`,
    ts: new Date().toISOString(),
    level: entry.level ?? 'info',
    text: entry.text,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
  });
  if (history.length > NOTICE_HISTORY_CAP) history.length = NOTICE_HISTORY_CAP;
}

/** Newest first, clamped to the ring size and to `limit` when given. */
export function listSystemNotices(limit?: number): SystemNoticeEntry[] {
  return limit === undefined ? history.slice() : history.slice(0, limit);
}

/** Test-only: clear the history and reset the id counter. */
export function resetSystemNoticeHistory(): void {
  history = [];
  nextId = 1;
}
