// input:  Thread DTOs and active/recent/history scope
// output: status filters and recent terminal threads
// pos:    Shared desktop/mobile thread scope model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ThreadInfo } from '@cortex-agent/ui-contract';

export type Scope = 'active' | 'recent' | 'history';

const RECENT_DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_ACTIVE = ['running', 'waiting'] as const;
const THREAD_HISTORY = ['completed', 'failed', 'cancelled', 'aborted'] as const;
const TERMINAL = new Set<ThreadInfo['status']>(THREAD_HISTORY);

/** threads.list status filter: recent is a time-windowed subset of terminal history. */
export function threadScopeFilter(scope: Scope): string[] {
  return scope === 'active' ? [...THREAD_ACTIVE] : [...THREAD_HISTORY];
}

function recentTimestamp(value: string, now: number): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const age = now - timestamp;
  return age >= 0 && age <= RECENT_DAY_MS ? timestamp : null;
}

/** Terminal threads updated within the last 24 hours, newest first. */
export function recentTerminalThreads(threads: ThreadInfo[], now: number): ThreadInfo[] {
  return threads
    .map((thread) => ({ thread, timestamp: recentTimestamp(thread.updatedAt, now) }))
    .filter((item): item is { thread: ThreadInfo; timestamp: number } => (
      TERMINAL.has(item.thread.status) && item.timestamp !== null
    ))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((item) => item.thread);
}
