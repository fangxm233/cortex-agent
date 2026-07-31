// input:  Thread DTO lifecycle statuses
// output: fixed active and history thread groups
// pos:    Shared desktop/mobile thread grouping model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ThreadInfo } from '@cortex-agent/ui-contract';

export const THREAD_GROUP_ORDER = ['active', 'history'] as const;
export type ThreadGroupKind = (typeof THREAD_GROUP_ORDER)[number];

export interface ThreadGroup {
  kind: ThreadGroupKind;
  threads: ThreadInfo[];
}

const THREAD_STATUSES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'aborted',
] as const satisfies readonly ThreadInfo['status'][];

const GROUP_BY_STATUS: Record<ThreadInfo['status'], ThreadGroupKind> = {
  running: 'active',
  waiting: 'active',
  completed: 'history',
  failed: 'history',
  cancelled: 'history',
  aborted: 'history',
};

/** Status filters for consumers that only need one lifecycle group. */
export function threadScopeFilter(kind: ThreadGroupKind): ThreadInfo['status'][] {
  return THREAD_STATUSES.filter((status) => GROUP_BY_STATUS[status] === kind);
}

/** Bucket threads into fixed lifecycle sections while preserving input order. */
export function groupThreads(threads: ThreadInfo[]): ThreadGroup[] {
  return THREAD_GROUP_ORDER
    .map((kind) => ({
      kind,
      threads: threads.filter((thread) => GROUP_BY_STATUS[thread.status] === kind),
    }))
    .filter((group) => group.threads.length > 0);
}
