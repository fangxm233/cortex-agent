// input:  what a `runThread` family call returned (or threw)
// output: the one verdict every renderer and every caller branches on
// pos:    orchestration/thread-run — kept in its own module so the renderers can name the verdict
//         without importing the runner (and so the rule lives in exactly one place, plan §1.2-6).

import type { ThreadRunResult } from '@domain/threads/runner.js';

export type ThreadVerdict =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting'
  | 'rate_limited'
  | 'rate_limited_exhausted';

/** The verdict rule, once:
 *  - a throw is `cancelled` when it carries `.cancelled` (the Cancel button / `!stop`), else `failed`;
 *  - a return is read off the PERSISTED status — `waiting` (thread_wait) and `rate_limited`
 *    (provider pause) are both non-terminal re-entry points, not completions;
 *  - a run that reports `rateLimited` without the thread being paused exhausted every fallback;
 *  - everything else — including `aborted` and `split` — is a completion whose summary text
 *    already spells out which (`buildThreadSummary`).
 */
export function classifyThreadVerdict(result: ThreadRunResult | null, error: Error | null): ThreadVerdict {
  if (error) return (error as Error & { cancelled?: boolean }).cancelled ? 'cancelled' : 'failed';
  const status = result?.thread?.status;
  if (status === 'waiting') return 'waiting';
  if (status === 'rate_limited') return 'rate_limited';
  if ((result?.lastAgentResult as { rateLimited?: boolean } | null)?.rateLimited) return 'rate_limited_exhausted';
  return 'completed';
}
