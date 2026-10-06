import { createLogger } from '@core/log.js';
import type { ChatNoticeLevel, NoticeAction } from '@core/types/agent-types.js';
import { isApiRateLimitError } from '@domain/runs/retryable-errors.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { t } from '../../core/i18n.js';
import type { HoldRenderer, HoldTotals, SealedVerdict } from './background-hold.js';

const log = createLogger('hold-render-web');

export interface WebHoldDeps {
  /** Append + publish a continuation NOTICE row (level + optional action), so a held API error
   *  renders as an error card and a resumable rate limit carries its resume affordance. */
  publishNotice: (text: string, level: ChatNoticeLevel, action?: NoticeAction) => void;
}

/**
 * The session-event rendering of a held turn.
 *
 * Rate-limit API errors are HELD, not streamed. The backend surfaces a 429 as ordinary assistant
 * prose BEFORE the continuation settles, and only the result says whether it was a failure (show
 * the card) or a pause the resume registry already owns (show the auto-resume warning instead).
 * Same contract as AttemptNoticeTracker in domain/runs/notices.ts — which is bound to the
 * foreground turn and has therefore already retired by the time a continuation runs.
 */
export function webHoldRenderer(deps: WebHoldDeps): HoldRenderer {
  let heldApiError: string | null = null;
  const flushHeldApiError = (): void => {
    const held = heldApiError;
    heldApiError = null;
    if (!held) return;
    deps.publishNotice(held, 'error');
  };

  return {
    // The web surface has no waiting line: the held state IS the session.status the hold publishes.
    onWaiting(): void {},

    onText(text: string, subagent?: ToolUseSubagent): 'held' | void {
      // Only the agent's own stream is held: a subagent's card keeps its attribution and the
      // subagent, not the session, owns that failure.
      if (!subagent && text.startsWith('API Error:') && isApiRateLimitError(text)) {
        heldApiError = text;
        return 'held';
      }
    },

    onSealed(kind: SealedVerdict, totals: HoldTotals): void {
      if (kind === 'max-wait') {
        // The cap releases the session, it does not end the turn: the subscription stays and a very
        // late continuation still streams. Nothing is flushed — the held card is still pending.
        log.info('web bg-hold max-wait cap — releasing (subscription kept for a late continuation)');
        return;
      }
      if (kind === 'grace') log.info('web bg-hold grace timeout — sealing session idle');
      if (kind === 'rate-limited' && totals.resumable) {
        // Paused, not failed — the held card would misreport the outcome.
        heldApiError = null;
        deps.publishNotice(t('notify.rateLimitAutoResume'), 'warning', { kind: 'cancel-resume' });
      }
      flushHeldApiError();
    },
  };
}
