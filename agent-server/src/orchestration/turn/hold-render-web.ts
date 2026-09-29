import { createLogger } from '@core/log.js';
import type { ChatNoticeLevel, ContextUsage, NoticeAction } from '@core/types/agent-types.js';
import { isApiRateLimitError } from '@domain/agents/config.js';
import type { ToolUseSubagent } from '../../agent-adapter/normalize/event-types.js';
import { t } from '../../core/i18n.js';
import type { HoldRenderer, HoldTotals, SealedVerdict } from './background-hold.js';

const log = createLogger('hold-render-web');

export interface WebHoldDeps {
  /** Append + publish a continuation assistant message (history record + session.message).
   *  `subagent` is set when a native subagent produced the text — without it the transcript
   *  cannot tell a subagent's working notes from the agent's own answer. */
  publishAssistant: (text: string, subagent?: ToolUseSubagent) => void;
  /** Append + publish a continuation tool call (history record + session.message). */
  publishTool: (name: string, input: any, toolUseId: string, subagent?: ToolUseSubagent) => void;
  /** Persist a complete normalized continuation tool result in DEBUG mode. */
  publishToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
  /** Publish the authoritative end of one backgrounded subagent. Distinct from the hold's seal:
   *  several subagents can run under one hold and each ends alone. */
  publishSubagentEnd?: (parentToolUseId: string, status: 'completed' | 'failed' | 'killed') => void;
  /** Persist and publish an exact continuation context snapshot. */
  publishContextUsage?: (usage: ContextUsage) => void;
  /** Append + publish a continuation NOTICE row (level + optional action), the fields the plain
   *  assistant path drops, so a held API error renders as an error card and a resumable rate limit
   *  carries its resume affordance. */
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

    onText(text: string, subagent?: ToolUseSubagent): void {
      if (!text) return;
      // Only the agent's own stream is held: a subagent's card keeps its attribution and the
      // subagent, not the session, owns that failure.
      if (!subagent && text.startsWith('API Error:') && isApiRateLimitError(text)) {
        heldApiError = text;
        return;
      }
      deps.publishAssistant(text, subagent);
    },

    onTool(name: string, input: unknown, toolUseId: string, subagent?: ToolUseSubagent): void {
      deps.publishTool(name, input, toolUseId, subagent);
    },

    onToolResult(toolUseId: string, content: string, isError: boolean): void {
      deps.publishToolResult?.(toolUseId, content, isError);
    },

    onContext(usage: ContextUsage): void {
      deps.publishContextUsage?.(usage);
    },

    onSubagentEnd(parentToolUseId: string, status: 'completed' | 'failed' | 'killed'): void {
      // Not routed through publishAssistant/publishTool: this is a state correction for a subagent
      // block, carrying no prose that belongs in the transcript.
      deps.publishSubagentEnd?.(parentToolUseId, status);
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
