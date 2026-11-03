import { recordResume } from '../../costs/resume-registry.js';
import { isProviderRateLimited } from '../../costs/rate-limit-throttle.js';
import { throttleKey } from '../../costs/throttle-key.js';
import type { EngineSelection } from '../../agents/engine-selection.js';
import { resumeFailover, type FailoverDeps } from '../account-failover.js';

/** A direct (interactive conversation) resume candidate.
 *
 *  `userMessage` is the RAW user text, never the assembled prompt: resuming replays it through the
 *  normal routing path, which composes the prompt again. Handing it a composed prompt would double
 *  every ambient block on the replayed turn. */
export interface DirectResumeInput {
  /** The provider the interrupted attempt was attributed to. */
  provider: string | null | undefined;
  /** The route (connection) it ran on; the entry waits for that route's throttle alone. */
  route?: string | null;
  channel: string;
  /** Stable Cortex tracking id, not the backend session id. Null when the turn had no track record. */
  trackSessionId: string | null;
  userMessage: string;
  /** The session's selection the interrupted run started from; with account failover on, the
   *  entry continues at once on another login instead of waiting for this one. */
  selection?: EngineSelection | null;
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
export function recordDirectResume(input: DirectResumeInput, failover: FailoverDeps = {}): boolean {
  if (!isProviderRateLimited(input.provider, input.route)) return false;
  const target = input.selection ? resumeFailover(input.selection, input, failover) : null;
  recordResume({
    kind: 'direct',
    // A failover entry waits on the login it continues on, which is free: it is ready now.
    provider: input.provider ? throttleKey(input.provider, target?.to ?? input.route) : null,
    ...(target ? { failover: true } : {}),
    channel: input.channel,
    trackSessionId: input.trackSessionId,
    userMessage: input.userMessage,
    recordedAt: Date.now(),
  });
  return true;
}
