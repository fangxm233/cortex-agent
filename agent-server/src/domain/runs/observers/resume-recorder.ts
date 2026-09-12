// input:  a rate-limited run's provider, channel, track id and the raw user message
// output: recordDirectResume / recordThreadResume — the resume queue's only writers
// pos:    Resume-queue policy: which interrupted work is worth resuming, and with what
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { recordResume } from '../../costs/resume-registry.js';
import { isProviderRateLimited } from '../../costs/rate-limit-throttle.js';

/** A direct (interactive conversation) resume candidate.
 *
 *  `userMessage` is the RAW user text, never the assembled prompt: resuming replays it through the
 *  normal routing path, which composes the prompt again. Handing it a composed prompt would double
 *  every ambient block on the replayed turn. */
export interface DirectResumeInput {
  /** The provider the interrupted attempt was attributed to. */
  provider: string | null | undefined;
  channel: string;
  /** Stable Cortex tracking id, not the backend session id. Null when the turn had no track record. */
  trackSessionId: string | null;
  userMessage: string;
}

/**
 * Record an interrupted conversation for auto-resume when the rate-limit window resets.
 *
 * The gate is load-bearing and is the reason this is one function rather than five copies: only a
 * provider whose throttle is ACTIVE may be queued. A 429 from a provider that is not throttled is a
 * terminal failure — queueing it creates an entry whose reset callback will never fire, so the work
 * waits forever and the user is told it will resume. `rate-limit-throttle` is the sole authority on
 * which providers are currently held.
 *
 * Returns whether the entry was queued, so a caller can choose between "paused, will auto-resume"
 * and "failed" wording without asking the throttle a second time.
 */
export function recordDirectResume(input: DirectResumeInput): boolean {
  if (!isProviderRateLimited(input.provider)) return false;
  recordResume({
    kind: 'direct',
    provider: input.provider ?? null,
    channel: input.channel,
    trackSessionId: input.trackSessionId,
    userMessage: input.userMessage,
    recordedAt: Date.now(),
  });
  return true;
}

/** A thread-pipeline resume candidate. */
export interface ThreadResumeInput {
  provider: string | null;
  threadId: string;
  channel: string;
  userMessage: string;
}

/**
 * Record an interrupted thread for auto-resume. Unconditional by design, unlike the direct path:
 * the thread callers have already committed to the pause (`markThreadRateLimited` moved the thread
 * to `rate_limited`, or boot found it already there), so a thread left out of the queue would be
 * stranded in a paused state with nothing able to restart it. The queue tolerates an entry whose
 * provider is not throttled — `takeReadyResumes` simply releases it on the next drain.
 */
export function recordThreadResume(input: ThreadResumeInput): void {
  recordResume({
    kind: 'thread',
    provider: input.provider,
    threadId: input.threadId,
    channel: input.channel,
    userMessage: input.userMessage,
    recordedAt: Date.now(),
  });
}
