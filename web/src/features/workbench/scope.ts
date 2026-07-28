// input:  Active/History UI scope
// output: thread-status filters for server queries
// pos:    Shared workbench/mobile scope mapping
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export type Scope = 'active' | 'history';

// Thread status vocabulary (ui-service types.ts ThreadInfo.status):
// running | waiting | completed | failed | cancelled | aborted.
const THREAD_ACTIVE = ['running', 'waiting'] as const;
const THREAD_HISTORY = ['completed', 'failed', 'cancelled', 'aborted'] as const;

/** threads.list `status` filter for a scope: live threads vs terminal ones. */
export function threadScopeFilter(scope: Scope): string[] {
  return scope === 'active' ? [...THREAD_ACTIVE] : [...THREAD_HISTORY];
}
